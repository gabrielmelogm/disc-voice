# Produção (AWS Lightsail)

Instância `disc-voice-api` (sa-east-1, Ubuntu 24.04, 2 GB + 2 GB de swap), IP estático `disc-voice-ip`, domínio `discvoice.devgabrielmelo.shop` (Cloudflare, DNS only). Firewall: 22, 80 e 443/TCP.

No servidor, `/opt/disc-voice` contém este `compose.yaml`, o `Caddyfile` e o `.env` de produção (chmod 600). O `.env` só existe no servidor: `DOMAIN`, `PUBLIC_WEB_URL`, `CORS_ORIGINS`, `POSTGRES_PASSWORD` e as chaves do Google, Discord, TURN da Cloudflare e Klipy. O `KLIPY_TOKEN` vem do secret de mesmo nome no GitHub: o deploy da API (`.github/workflows/api.yml`) grava o valor no `.env` antes de reiniciar a API. Sem o secret, o valor que já estiver no servidor continua valendo.

O Caddy emite e renova o certificado do Let's Encrypt e encaminha HTTP e WebSocket para a API. A voz usa o TURN da Cloudflare, por isso não há Coturn aqui.

## Atualizar a API

A instância não tem memória para compilar, então a imagem é gerada localmente (x86_64):

```powershell
docker build --platform linux/amd64 -f infra/docker/api.Dockerfile -t disc-voice-api:prod .
docker save disc-voice-api:prod -o api.tar
scp -i ~/.ssh/disc-voice-lightsail api.tar ubuntu@52.67.198.194:/tmp/api.tar
ssh -i ~/.ssh/disc-voice-lightsail ubuntu@52.67.198.194 "docker load -i /tmp/api.tar && rm /tmp/api.tar && cd /opt/disc-voice && docker compose up -d api"
```

As migrações rodam ao iniciar a API.

## Operação

```sh
cd /opt/disc-voice
docker compose ps
docker compose logs -f api
docker compose exec -T db pg_dump -U discvoice -d discvoice -Fc > backup.dump
```
