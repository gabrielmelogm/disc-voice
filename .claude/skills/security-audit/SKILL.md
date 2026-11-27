---
name: security-audit
description: Auditoria de segurança do Disc Voice antes da produção, somente leitura. Verifica segredos expostos, rotas sem autenticação, IDOR, regras de banco permissivas, injeção/XSS e dependências vulneráveis, e publica o resultado como comentário na PR indicada. É acionada pela skill release logo depois de criar a PR de versão; também pode ser usada à mão com o número de uma PR.
argument-hint: "<número da PR>"
---

# Auditoria de segurança

Atue como um engenheiro de segurança sênior auditando este codebase antes da produção.

**Não modifique arquivos do repositório.** Nada de `Edit`, `Write` dentro do repo, `git commit`,
`npm audit fix`, `cargo update` etc. O único arquivo escrito é o relatório, no scratchpad. A
única ação externa é o comentário na PR.

## 0. Entrada

O argumento é o número da PR (a skill release passa o da PR de versão). Sem argumento, use a PR
da branch atual (`gh pr view --json number -q .number`); se não houver, pergunte ao usuário.

Audite o código **como está em `origin/main` mais a PR** — na prática, o checkout da branch da
PR. Confirme com `git rev-parse --abbrev-ref HEAD` e anote o SHA (`git rev-parse --short HEAD`)
para citar no comentário.

## 1. Escopo do projeto

- `apps/api` — API Rust (axum 0.8, WebSocket, SeaORM/sqlx com Postgres, migrations).
- `apps/desktop` — app Tauri (frontend Vite/TS em `src`, backend Rust em `src-tauri`).
- `apps/website` — site Next.js (deploy na Vercel).
- `infra/docker`, `infra/terraform` — infraestrutura (compose, Dockerfiles, AWS via Terraform).
- `.github/workflows` — CI/CD (segredos, permissões dos tokens, `pull_request_target` etc.).

Ignore `node_modules`, `target`, `dist`, `.next`, `.terraform` e `.claude/worktrees`.

## 2. Verificações

Para ler o código em volume, use subagentes `Explore`/`general-purpose` em paralelo (um por
categoria ou por app) e confirme você mesmo cada achado lendo o arquivo e a linha antes de
reportá-lo. Só reporte o que tiver arquivo, linha e cenário de ataque plausível; descarte
suspeitas não confirmadas.

1. **Segredos** — chaves de API, tokens, senhas, chaves privadas no código, no frontend
   (`apps/desktop/src`, `apps/website/src`, variáveis `VITE_*`/`NEXT_PUBLIC_*` com valores
   sensíveis), em `tauri.conf.json`, Dockerfiles, compose, Terraform (`*.tfvars`, state) e
   workflows. Verifique também o **histórico do git**:
   `git log -p --all -S "<padrão>"` para padrões como `AKIA`, `-----BEGIN`, `sk_`, `ghp_`,
   `password`, `secret`, `token`, e `git log --all --diff-filter=A --name-only` procurando
   `.env`, `*.pem`, `*.key`, `*.tfstate`. **Nunca copie o valor do segredo para o comentário**:
   mostre só o arquivo, a linha/commit e os 4 primeiros caracteres seguidos de `…`.
2. **Autenticação** — monte o mapa de rotas do router axum (HTTP e WS) e os middlewares/
   extractors de auth. Aponte rotas que leem ou alteram dados sem exigir sessão/JWT, upgrade
   de WebSocket sem auth, validação fraca de token (sem checar assinatura, expiração ou
   algoritmo), segredo JWT padrão/hardcoded, CORS permissivo com credenciais.
3. **Autorização (IDOR)** — handlers que recebem IDs (servidor, canal, mensagem, usuário,
   convite) e consultam/alteram sem checar se o usuário autenticado é membro/dono/tem
   permissão. Inclua eventos de WebSocket (entrar em canal de voz, enviar mensagem em canal
   alheio) e comandos Tauri expostos ao frontend.
4. **Banco de dados** — o projeto usa Postgres via SeaORM, então "RLS" aqui significa: políticas
   RLS nas migrations (se existirem), usuário do banco com privilégios excessivos (superuser,
   dono do schema usado pela API), credenciais padrão no compose/Terraform, Postgres exposto
   publicamente (security group, porta publicada), conexões sem TLS em produção.
5. **Injeção** — SQL montado com `format!`/concatenação (`Statement::from_string`,
   `query_raw`, `sqlx::query(&format!(..))`), comandos de shell com entrada do usuário,
   path traversal, XSS no desktop/site (`innerHTML`, `dangerouslySetInnerHTML`, markdown sem
   sanitização, links `javascript:`), CSP do Tauri ausente ou com `unsafe-inline`/`*`,
   allowlist/capabilities do Tauri amplas demais (fs, shell, http).
6. **Dependências** — rode (somente leitura):
   ```powershell
   npm audit --workspaces --json
   cargo audit --json        # se não estiver instalado, registre isso no relatório e não instale sem perguntar
   ```
   Para cada vulnerabilidade relevante, cite o pacote, a versão, o advisory e a versão
   corrigida. Aponte também crates/pacotes abandonados (marcados `unmaintained` pelo RustSec
   ou sem release há anos e usados em caminho sensível).

## 3. Severidade

- **Crítica** — explorável remotamente sem autenticação, ou segredo de produção válido exposto,
  ou leitura/escrita de dados de qualquer usuário.
- **Alta** — explorável por usuário autenticado comum contra outros usuários, ou
  vulnerabilidade conhecida com exploit em dependência alcançável.
- **Média** — exige condições específicas, impacto limitado, ou falta de defesa em
  profundidade (CSP, rate limit, hardening).

Ordene por severidade (Crítica → Alta → Média) e, dentro dela, por impacto.

## 4. Relatório

Escreva em `<scratchpad>\security-audit-pr<número>.md`, neste formato:

```markdown
## 🔒 Auditoria de segurança — <commit curto>

**Resultado:** <🔴 N críticas · 🟠 N altas · 🟡 N médias> | <✅ Nenhuma falha encontrada>

| # | Severidade | Categoria | Arquivo:linha |
|---|---|---|---|
| 1 | 🔴 Crítica | Autorização | `apps/api/src/...rs:42` |

### 1. <título curto> — 🔴 Crítica
- **Arquivo:** [`apps/api/src/...rs:42`](https://github.com/<owner>/<repo>/blob/<sha>/apps/api/src/...rs#L42)
- **Cenário de ataque:** <passo a passo de como explorar>
- **Correção recomendada:** <o que mudar, com trecho de código se ajudar>

...

<details><summary>Escopo e limitações</summary>

- Categorias verificadas: segredos, autenticação, autorização, banco, injeção, dependências.
- Ferramentas: npm audit (<ok/falhou>), cargo audit (<ok/não instalado>).
- O que não foi possível verificar (ex.: configuração real da AWS/Vercel, segredos do GitHub).
</details>

_Auditoria automática gerada pela skill `security-audit`; não substitui um pentest._
```

Use o owner/repo de `gh repo view --json nameWithOwner -q .nameWithOwner` e o SHA completo
nos links. Se o relatório passar de ~60 000 caracteres, resuma os achados Médios em tabela.

## 5. Comentar na PR

```powershell
gh pr comment <número> --body-file "<scratchpad>\security-audit-pr<número>.md"
```

Se esta for uma rodada repetida e o último comentário seu na PR for a auditoria anterior
(começa com `## 🔒 Auditoria de segurança`), use `gh pr comment <número> --edit-last
--body-file ...` em vez de criar outro.

Depois, diga ao usuário em uma ou duas linhas o resultado (contagem por severidade) e o link do
comentário. **Se houver achado Crítico ou Alto**, destaque isso e recomende não dar merge na PR
de release até decidir o que fazer — mas não feche nem bloqueie a PR por conta própria.
