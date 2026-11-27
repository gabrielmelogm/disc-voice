---
name: production-readiness
description: Revisão de prontidão para produção do Disc Voice, somente leitura. Verifica HTTPS e headers de segurança (CSP, X-Frame-Options, HSTS), modo debug e erros verbosos, rotas de teste/admin/playground expostas, rate limiting e validação de entrada no servidor, e publica na PR um comentário com as configurações necessárias no painel de hospedagem e as mudanças de código. É acionada pela skill release logo depois de criar a PR de versão; também pode ser usada à mão com o número de uma PR.
argument-hint: "<número da PR>"
---

# Preparação para produção

Atue como um engenheiro sênior preparando este aplicativo para produção.

**Esta skill não modifica o repositório.** Ela levanta o que falta e **lista** as mudanças de
código e as configurações de hospedagem necessárias; quem aplica é o usuário (ou uma sessão
separada, se ele pedir). O único arquivo escrito é o relatório, no scratchpad, e a única ação
externa é o comentário na PR.

## 0. Entrada

O argumento é o número da PR (a skill release passa o da PR de versão). Sem argumento, use a PR
da branch atual (`gh pr view --json number -q .number`); se não houver, pergunte ao usuário.
Analise o checkout da branch da PR e anote o SHA (`git rev-parse HEAD`) para os links.

## 1. Onde cada coisa roda

Confirme lendo os arquivos, porque isso pode ter mudado:

- **API** (`apps/api`, Rust/axum + WebSocket, Postgres): instância AWS Lightsail criada por
  `infra/terraform/main.tf` (IP estático, portas públicas, bucket), rodando
  `infra/docker/prod/compose.yaml` atrás do **Caddy** (`infra/docker/prod/Caddyfile`), que
  termina o TLS. Deploy por `.github/workflows/api.yml`.
- **Site** (`apps/website`, Next.js): Vercel (`apps/website/vercel.json`, `next.config.ts`).
- **Desktop** (`apps/desktop`, Tauri): CSP e capabilities em `src-tauri/tauri.conf.json` e
  `src-tauri/capabilities`; conexões com a API (URLs `http://`/`ws://` vs `https://`/`wss://`).

Ignore `node_modules`, `target`, `dist`, `.next`, `.terraform` e `.claude/worktrees`.

## 2. Verificações

Use subagentes `Explore`/`general-purpose` em paralelo para varrer o código, e confirme cada
item lendo o arquivo e a linha antes de reportá-lo. Para cada item, diga se está **OK**,
**Parcial** ou **Faltando**.

1. **HTTPS e headers de segurança**
   - Caddy: redirect HTTP→HTTPS, HSTS (`Strict-Transport-Security` com `max-age` ≥ 1 ano,
     `includeSubDomains`), `X-Frame-Options: DENY` (ou `frame-ancestors`),
     `X-Content-Type-Options: nosniff`, `Referrer-Policy`, CSP; header `Server` removido.
   - Lightsail: portas públicas só 80/443 (e 22 restrita); API e Postgres não expostos direto.
   - Next/Vercel: `headers()` em `next.config.ts` ou `vercel.json` com CSP, HSTS,
     X-Frame-Options, `Permissions-Policy`.
   - Tauri: CSP definida (sem `unsafe-eval`, `*` ou `null`), `connect-src` só com `https:`/
     `wss:` da API de produção.
   - CORS da API: origens explícitas, sem `*` com credenciais.
2. **Debug e erros verbosos**
   - API: `RUST_LOG`/nível de log de produção, `RUST_BACKTRACE` desligado, respostas de erro
     sem mensagens internas (`{e:?}`, erros do sqlx/SeaORM, stack) para o cliente.
   - Desktop: devtools desabilitado no build de release, `console.log` com dados sensíveis,
     sourcemaps no bundle.
   - Site: `productionBrowserSourceMaps`, páginas de erro genéricas, variáveis `NEXT_PUBLIC_*`.
3. **Rotas de teste, admin e playgrounds** — rotas `/debug`, `/test`, `/admin`, `/dev`,
   `/seed`, `/health` com informação demais, Swagger/OpenAPI/GraphQL playground, endpoints
   habilitados só por feature flag ou `cfg(debug_assertions)` que vazem para release.
   Para cada uma: remover, proteger com auth de admin ou restringir por rede.
4. **Rate limiting** — login, signup, reset de senha, criação de convites, envio de mensagens
   via WebSocket, upload para o bucket e qualquer endpoint que custe dinheiro (e-mail, IA,
   armazenamento). Verifique se há `tower_governor`/`tower::limit` ou equivalente, e o
   `rate_limit` do Caddy se usado. Indique limites concretos sugeridos (ex.: login 5/min por
   IP + por conta) e a chave (IP real via `X-Forwarded-For` confiável só do Caddy).
5. **Validação de entrada no servidor** — todos os handlers axum (`Json`, `Query`, `Path`,
   mensagens WS desserializadas): tipos rigorosos, `#[serde(deny_unknown_fields)]`, limites de
   tamanho (string, arrays, `DefaultBodyLimit`, tamanho de frame WS), formatos (e-mail, UUID),
   validação com `validator`/`garde` ou equivalente, e resposta 400/422 genérica.

## 3. Relatório

Escreva em `<scratchpad>\production-readiness-pr<número>.md`:

```markdown
## 🚀 Preparação para produção — <commit curto>

**Resumo:** <N ✅ OK · N 🟡 parciais · N 🔴 faltando>

| Item | Status | Onde |
|---|---|---|
| HTTPS + HSTS | 🔴 Faltando | `infra/docker/prod/Caddyfile` |
| ... | | |

### ⚙️ Configurações no painel de hospedagem
#### AWS Lightsail / Terraform
- [ ] <configuração> — <por quê>
#### Vercel
- [ ] <configuração> — <por quê>
#### GitHub (secrets, environments, branch protection)
- [ ] ...

### 🛠️ Mudanças de código
#### 1. <título> — 🔴 Faltando
- **Arquivo:** [`caminho:linha`](https://github.com/<owner>/<repo>/blob/<sha>/caminho#Llinha)
- **Problema:** <o que está faltando e o risco>
- **Mudança:** <trecho de código ou config sugerido>

...

<details><summary>Escopo e limitações</summary>

- O que foi verificado e o que não foi possível verificar (configuração real nos painéis,
  DNS, variáveis de ambiente de produção).
</details>

_Revisão automática gerada pela skill `production-readiness`; nenhum arquivo foi alterado._
```

Ordene as mudanças de código por risco (🔴 antes de 🟡). Use checkboxes nas configurações de
painel para o usuário marcar na própria PR. Owner/repo vêm de
`gh repo view --json nameWithOwner -q .nameWithOwner`. Se passar de ~60 000 caracteres, resuma
os itens 🟡 em tabela.

## 4. Comentar na PR

```powershell
gh pr comment <número> --body-file "<scratchpad>\production-readiness-pr<número>.md"
```

Se esta for uma rodada repetida e o último comentário seu na PR for este relatório (começa com
`## 🚀 Preparação para produção`), use `--edit-last` em vez de criar outro.

Depois, diga ao usuário em uma ou duas linhas o resumo (OK/parciais/faltando) e o link do
comentário. Não aplique as mudanças por conta própria; se o usuário quiser, ofereça fazê-las
numa branch/sessão separada da release.
