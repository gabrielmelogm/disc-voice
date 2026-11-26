---
name: release
description: Cria uma release do Disc Voice no GitHub. Pergunta o estágio (alpha, beta ou stable; padrão alpha), calcula a próxima versão SemVer pelos commits convencionais desde a última release, abre uma PR `release(<estágio>): vX.Y.Z` que só muda a versão nos package.json, Cargo.toml e README e, depois do merge, publica a release com as notas agrupadas por tipo. Use quando pedirem para criar, publicar ou lançar uma release/versão.
argument-hint: "[alpha|beta|stable]"
---

# Release no GitHub

O fluxo tem duas fases, porque `main` só recebe mudanças por PR:

1. **PR de versão**: `release(<estágio>): v<versão>`, só com a versão nova nos manifestos e no README.
2. **Release**: depois do merge, a release é criada no commit de `main` que já tem a versão.

Ao rodar a skill, o script detecta em qual fase o projeto está (`pendingOnMain`).

O merge da PR de versão não dispara CI: os jobs de `api.yml`, `website.yml` e `windows.yml`
são pulados quando o commit de push começa com `release(`. Por isso o título da PR (que vira
a mensagem do squash) precisa seguir exatamente esse formato. O CI só roda quando a release
é publicada.

Publicar uma release dispara o job `release` de `.github/workflows/windows.yml`, que gera o
instalador do Windows a partir da tag, anexa à release e envia ao bucket. Releases `stable`
também substituem o `releases/latest/` que o botão de download do site usa. Por isso,
**nada é enviado ao GitHub (push, PR ou release) sem a confirmação explícita do usuário**.

## 1. Calcular a versão

```powershell
git fetch origin --tags --quiet
node .claude/skills/release/next-version.mjs --channel <estágio> --target origin/main --notes-out "<scratchpad>\release-notes.md"
```

Na primeira rodada, use `--channel alpha` só para ver se há `pendingOnMain`. Se houver, pule
para a **fase 2**: o estágio vem da própria versão (campo `channel`), sem perguntar.

Se não houver, pergunte o estágio. Se o argumento da skill já for `alpha`, `beta` ou
`stable`, use-o. Senão, pergunte com `AskUserQuestion` ("Qual o estágio do projeto para esta
release?") e rode o script de novo com o estágio escolhido:

- **alpha (Recomendado)**: pré-release, o padrão por enquanto
- **beta**: pré-release
- **stable**: release estável (vira a "Latest" e atualiza o download do site)

O script só lê git e gh. Ele devolve um JSON com `lastRelease`, `bump`, `tag`, `channel`,
`prerelease`, `pendingOnMain`, `commits`, `warnings` e `notes`. Estas são as regras que ele
aplica:

- **Commits convencionais** (`tipo(escopo)!: descrição`):
  - `feat` ou `feature` → minor
  - `fix` ou `perf` → patch
  - `!` no tipo ou `BREAKING CHANGE:` no corpo → major
  - Outros tipos (`chore`, `docs`, `ci`…) entram nas notas, mas não sobem a versão.
  - Commits `release(...)` ficam de fora das notas.
- **SemVer**: o bump é medido desde a última release **stable** (ou desde o início, se não
  houver). Enquanto a versão for `0.x`, uma quebra sobe só o minor.
- **Pré-releases**: `X.Y.Z-alpha.N` ou `X.Y.Z-beta.N`. `X.Y.Z` é a próxima versão estável, e
  `N` aumenta dentro do mesmo canal. A tag antiga `Alpha` (título `v0.1.0-alpha`) conta como
  `alpha.0`.
- **Notas**: só os commits desde a última release, de qualquer canal.

Se `bump` vier `none` (só commits sem impacto na versão), avise o usuário e pergunte se deve
forçar com `--bump patch|minor|major`. Se houver outros `warnings`, mostre-os e resolva antes
de seguir. Por exemplo, se a tag já existe, não a sobrescreva.

## 2. Fase 1: PR de versão

**Confirmar.** Mostre um resumo curto: a última release → a nova versão, o tipo de bump e os
commits que o causaram, e as notas. Pergunte com `AskUserQuestion` se pode abrir a PR. Aceite
ajustes na versão antes de seguir.

**Branch a partir de `main`.** A árvore precisa estar limpa: arquivos rastreados modificados
bloqueiam, e arquivos não rastreados não importam porque não entram no commit.

```powershell
git switch -c release/v<versão> origin/main
node .claude/skills/release/bump-version.mjs --version <versão>
```

O `bump-version.mjs` troca a versão atual (a do `package.json` da raiz) pela nova nestes
arquivos:

- `package.json` da raiz e dos workspaces, e `package-lock.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- os `Cargo.toml` dos membros do workspace Rust, e `Cargo.lock`
- `README.md`: o texto e os badges do shields.io, onde `-` vira `--`

Ele imprime a lista de arquivos alterados. Confira se `git status --short` mostra só esses
arquivos e se os locks continuam válidos:

```powershell
cargo metadata --locked --format-version 1 --no-deps | Out-Null; $LASTEXITCODE
npm ls --workspaces --depth 0 | Out-Null; $LASTEXITCODE
```

**Commit, push e PR.** Adicione só os arquivos listados pelo script (nunca use `git add -A`).
O título da PR e a mensagem do commit seguem o formato `release(<estágio>): v<versão>`, por
exemplo `release(alpha): v0.1.0-alpha.1`.

```powershell
git add <arquivos listados>
git commit -m "release(<estágio>): v<versão>"
git push -u origin release/v<versão>
gh pr create --base main --head release/v<versão> --title "release(<estágio>): v<versão>" --body-file "<scratchpad>\release-notes.md"
```

Passe o link da PR ao usuário e avise que, depois do merge, basta rodar `/release` de novo
para publicar a release.

## 3. Fase 2: publicar a release (versão já em `main`)

Use a `tag`, o `channel` e as notas que o script calculou para `pendingOnMain`. Mostre-os ao
usuário e pergunte com `AskUserQuestion` se pode publicar. As opções são "Publicar", "Criar
como rascunho" e "Cancelar".

```powershell
gh release create v<versão> --target main --title v<versão> --notes-file "<scratchpad>\release-notes.md" <flags>
```

- alpha ou beta: `--prerelease`
- stable: `--latest`
- rascunho: acrescente `--draft`. O workflow só roda quando a release for publicada.

Antes de criar, confira se `git rev-parse origin/main` é o commit do merge da PR de versão. O
`gh` cria a tag nesse commit.

Depois, passe ao usuário o link da release e o run do workflow:

```powershell
gh run list --workflow windows.yml --event release --limit 1
```
