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

Ao publicar uma release no GitHub, `.github/workflows/desktop.yml` gera o instalador do Windows e os pacotes do Linux (AppImage, `.deb` e `.rpm`), anexa os arquivos à release e envia uma cópia de cada um para o mesmo bucket, na pasta `releases/`, sempre com estes nomes:

- `DiscVoice-Setup.exe`, `DiscVoice_x86_64.AppImage`, `DiscVoice_amd64.deb` e `DiscVoice_x86_64.rpm`
- em `releases/<tag>/`: cópia de cada versão;
- em `releases/latest/`: a release stable mais nova (ou a pré-release mais nova, enquanto não existe nenhuma stable).

O bucket continua privado. Os botões de download do site apontam para `/download/windows` e `/download/linux/{appimage,deb,rpm}` (`apps/website/src/lib/releases.ts`), que redirecionam para um link assinado do arquivo em `releases/latest/`, válido por 5 minutos. O site precisa das variáveis de ambiente `RELEASES_ACCESS_KEY_ID` e `RELEASES_SECRET_ACCESS_KEY` (no Vercel, ou no `.env` do compose). Sem elas, ou se o arquivo ainda não estiver no bucket, o botão leva para a página de releases do GitHub. Use uma chave de acesso própria do bucket para o site (o Lightsail permite duas por bucket), para revogá-la sem afetar a API:

```powershell
aws lightsail create-bucket-access-key --bucket-name disc-voice-files-481116707314 --region sa-east-1
```

### Atualização automática do app

Quando uma release é publicada, o workflow grava `releases/channels/<canal>.json` no bucket e chama `POST /api/releases/notify` na API, que avisa pelo realtime todo app aberto, inclusive quem está em chamada. O app (instalador do Windows e AppImage) mostra um botão discreto na barra, sem forçar nada. Quem estava offline descobre a versão ao abrir o app e a cada 4 horas, em `/api/update/latest?channel=<canal>` no site, que não devolve link nenhum.

Só quando o usuário clica em atualizar o app chama `https://get-discvoice.devgabrielmelo.shop/api/update/{target}/{arch}/{versão}`, e só essa rota (`apps/website/src/lib/updates.ts`) gera um link assinado (15 minutos) para o instalador em `releases/<tag>/`. O app baixa, confere a assinatura, instala e reinicia. Em chamada, a chamada continua durante o download e só é encerrada na hora de reiniciar. `.deb` e `.rpm` não se atualizam sozinhos.

- **Chave de assinatura:** a pública fica em `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); a privada e a senha, nos secrets `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Faça backup da chave privada: sem ela, as instalações existentes não recebem mais atualizações. Builds locais não assinam e não precisam dela.
- **Aviso em tempo real:** secret `RELEASE_NOTIFY_TOKEN` (um valor aleatório qualquer). O deploy da API grava no `.env` do servidor e o `desktop.yml` envia no aviso. Sem ele, os apps só descobrem a versão na próxima verificação.
- **Canais:** uma release entra no próprio canal e nos menos estáveis (stable → stable, beta e alpha; beta ou rc → beta e alpha; alpha → alpha), a não ser que o canal já ofereça uma versão mais nova.
- **Controle manual:** editar ou apagar `releases/channels/<canal>.json` no bucket segura, libera ou troca a versão oferecida.

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
