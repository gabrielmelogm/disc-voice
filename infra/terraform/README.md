# Terraform

A infraestrutura de produção da API fica em AWS Lightsail (`sa-east-1`). Todo recurso com suporte a tags recebe `terraform = "true"` e `project = "disc-voice"`, via `default_tags`.

| Pasta | O que gerencia | Quem aplica |
|---|---|---|
| `bootstrap/` | Bucket S3 do estado (`disc-voice-terraform-state-481116707314`, versionado e criptografado), provedor OIDC do GitHub e as roles IAM `disc-voice-github-terraform` (apply, só a `main`) e `disc-voice-github-terraform-plan` (só leitura, pull requests) | Manualmente, com credenciais de administrador |
| `.` (raiz) | Instância `disc-voice-api`, IP estático `disc-voice-ip`, anexo do IP, firewall (22, 80, 443) e o bucket de arquivos `disc-voice-files-481116707314` | GitHub Actions (`.github/workflows/terraform.yml`) em push na `main` |

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
- Secret `KLIPY_TOKEN`: chave da API do Klipy (GIFs). O deploy da API grava o valor no `.env` do servidor; o Terraform não guarda segredos da aplicação.

## Arquivos

Os arquivos enviados nos chats ficam no bucket do Lightsail `disc-voice-files-481116707314` (`aws_lightsail_bucket.files`). O plano `small_1_0` tem 5 GB e 25 GB de transferência por mês, é grátis nos primeiros 12 meses da conta e custa US$ 1/mês depois. O bucket é privado: a API valida cada envio (15 MB por arquivo, 1 GB por pessoa, extensões perigosas bloqueadas) e entrega links assinados que valem por poucos minutos.

A chave de acesso da API é criada uma vez, fora do Terraform, para o segredo não ficar no estado:

```powershell
aws lightsail create-bucket-access-key --bucket-name disc-voice-files-481116707314 --region sa-east-1
```

Guarde `accessKeyId` e `secretAccessKey` nos secrets `FILES_ACCESS_KEY_ID` e `FILES_SECRET_ACCESS_KEY` do repositório. O deploy da API grava os dois no `.env` do servidor, junto com `FILES_BUCKET` e `FILES_REGION`. Sem eles, a API guarda os arquivos no volume `api-uploads` da instância.

## Releases

Ao publicar uma release no GitHub, `.github/workflows/windows.yml` gera o instalador do Windows, anexa o arquivo à release e envia uma cópia para o mesmo bucket, na pasta `releases/`:

- `releases/<tag>/DiscVoice-Setup.exe`: cópia de cada versão.
- `releases/latest/DiscVoice-Setup.exe`: última release que não é pré-release.

O bucket continua privado. O botão de download do site aponta para `/download/windows` (`apps/website/src/app/download/windows/route.ts`), que redireciona para um link assinado de `releases/latest/DiscVoice-Setup.exe` válido por 5 minutos. O site precisa das variáveis de ambiente `RELEASES_ACCESS_KEY_ID` e `RELEASES_SECRET_ACCESS_KEY` (no Vercel, ou no `.env` do compose). Sem elas, o botão leva para a página de releases do GitHub. Use uma chave de acesso própria do bucket para o site (o Lightsail permite duas por bucket), para revogá-la sem afetar a API:

```powershell
aws lightsail create-bucket-access-key --bucket-name disc-voice-files-481116707314 --region sa-east-1
```

O workflow envia os arquivos com os secrets `FILES_ACCESS_KEY_ID` e `FILES_SECRET_ACCESS_KEY`. A tag da release vira a versão do app (`v1.2.3` vira `1.2.3`) e precisa seguir semver.

## Mudanças de custo

Em push na `main`, o apply só roda sozinho quando o plano não muda o custo mensal estimado (`.github/scripts/terraform-cost.js`, com os preços dos planos do Lightsail). Um recurso novo ou alterado cujo preço o script não conhece também conta como mudança de custo.

Quando o custo muda, o workflow **Terraform** falha no passo "Cost approval" e não aplica nada. Para aprovar, **@gabrielmelogm** abre Actions → Terraform → **Run workflow** na `main` e marca `approve_costs`. O workflow confere o login e o id do usuário (`73313748`) de quem disparou.

A regra vive no workflow: no plano Free do GitHub, repositórios privados não têm aprovadores obrigatórios nem proteção de branch, então quem tem acesso de escrita consegue alterar o workflow na `main` e contornar a verificação.

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
