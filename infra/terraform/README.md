# Terraform

A infraestrutura de produção da API fica em AWS Lightsail (`sa-east-1`). Todo recurso com suporte a tags recebe `terraform = "true"` e `project = "disc-voice"`, via `default_tags`.

| Pasta | O que gerencia | Quem aplica |
|---|---|---|
| `bootstrap/` | Bucket S3 do estado (`disc-voice-terraform-state-481116707314`, versionado e criptografado), provedor OIDC do GitHub e as roles IAM `disc-voice-github-terraform` (apply, só a `main`) e `disc-voice-github-terraform-plan` (só leitura, pull requests) | Manualmente, com credenciais de administrador |
| `.` (raiz) | Instância `disc-voice-api`, IP estático `disc-voice-ip`, anexo do IP e firewall (22, 80, 443) | GitHub Actions (`.github/workflows/terraform.yml`) em push na `main` |

Os recursos da raiz foram criados à mão e adotados com blocos `import`: o primeiro apply só adiciona as tags. A instância e o IP têm `prevent_destroy`, e o workflow recusa qualquer plano que apague ou substitua recursos, porque a instância guarda o PostgreSQL e os uploads. Mudar `bundle_id`, `blueprint_id` ou a zona substitui a instância: faça isso de propósito, com backup e fora do CI.

O par de chaves `disc-voice-key` não é gerenciado aqui (o Lightsail não permite importar pares de chaves).

## Bootstrap (uma vez)

```powershell
aws s3api create-bucket --bucket disc-voice-terraform-state-481116707314 --region sa-east-1 --create-bucket-configuration LocationConstraint=sa-east-1
cd infra/terraform/bootstrap
terraform init
terraform apply
```

Em seguida, configure no repositório:

- Variáveis `AWS_ROLE_ARN` e `AWS_PLAN_ROLE_ARN`: os outputs `github_role_arn` e `github_plan_role_arn`.
- Variáveis `LIGHTSAIL_HOST` (IP estático), `PUBLIC_URL` (`https://discvoice.devgabrielmelo.shop`) e `LIGHTSAIL_KNOWN_HOSTS` (chave do host SSH).
- Secret `LIGHTSAIL_SSH_KEY`: chave privada de deploy, cuja chave pública está em `~ubuntu/.ssh/authorized_keys` no servidor.

## Pull requests

`.github/workflows/terraform-plan.yml` roda em PRs que alteram `infra/terraform` (exceto `bootstrap/`). Ele executa `terraform plan` com a role só de leitura e mantém um único comentário no PR. O comentário traz o que será adicionado, alterado, substituído, destruído e importado, e o custo mensal antes e depois, calculado com os preços dos planos do Lightsail da região. Nada é aplicado no PR.

## Deploy da API

`.github/workflows/api.yml` testa a API e, na `main`, compila a imagem no runner, envia por SSH (`docker save | docker load`), troca a tag `disc-voice-api:prod` e reinicia só o container da API. A troca derruba a API por poucos segundos. Se `/api/health` não responder, o workflow volta para a imagem anterior (`disc-voice-api:previous`).

## Rodar localmente

```powershell
cd infra/terraform
terraform init
terraform plan
```
