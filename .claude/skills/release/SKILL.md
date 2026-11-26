---
name: release
description: Cria uma release do Disc Voice no GitHub. Pergunta o estágio (alpha, beta ou stable; padrão alpha), calcula a próxima versão SemVer pelos commits convencionais desde a última release, abre uma PR `release(<estágio>): vX.Y.Z` que só muda a versão nos package.json, Cargo.toml e README, espera o usuário revisar e dar merge e então publica a release, cujo workflow gera o instalador do Windows e o envia ao bucket do site. Use quando pedirem para criar, publicar ou lançar uma release/versão.
argument-hint: "[alpha|beta|stable]"
---

# Release no GitHub

O fluxo tem duas fases, porque `main` só recebe mudanças por PR:

1. **PR de versão**: `release(<estágio>): v<versão>`, só com a versão nova nos manifestos e
   no README. A skill abre a PR e **espera** o usuário revisar e dar merge.
2. **Release**: assim que a PR é mergeada, a skill cria a release no commit do merge.

Se a sessão acabar antes do merge, rodar `/release` de novo retoma: o script detecta que a
versão já está em `main` sem release (`pendingOnMain`) e vai direto para a fase 2.

O que roda no GitHub em cada passo:

- **Merge da PR de versão** (push em `main` com commit `release(`): só os **testes** de
  `api.yml`, `website.yml` e `windows.yml`. O deploy da API e a imagem do site são pulados.
  Por isso o título da PR (que vira a mensagem do squash) precisa começar com `release(`.
- **Release publicada** (pela skill ou à mão na aba Releases): o job `release` de
  `windows.yml` roda os testes de novo e depois:
  - gera o instalador e o anexa à release como `DiscVoice_<versão>_x64-setup.exe`, junto com
    um `SHA256SUMS`;
  - envia o instalador ao bucket em `releases/v<versão>/`;
  - atualiza `releases/latest/`, que o botão de download do site usa, quando a release é
    stable ou quando ainda não existe nenhuma stable (fase alpha), e nunca com uma versão mais
    antiga que a mais nova;
  - acrescenta às notas a seção "Qual arquivo baixar?", com a tabela de downloads e o hash.

**Antes de abrir a PR, peça a confirmação explícita do usuário.** O merge da PR, feito por ele,
é a aprovação para publicar a release. Não é preciso perguntar de novo, a não ser que a fase
2 comece numa nova execução de `/release`.

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

Passe o link da PR ao usuário e diga que a skill está esperando ele revisar e dar merge.

**Esperar o merge.** Rode em segundo plano (`run_in_background: true`). O comando termina
quando a PR deixa de estar aberta, e a sessão é avisada nesse momento:

```powershell
do { Start-Sleep 60; $s = gh pr view <número> --json state -q .state } while ($s -eq 'OPEN'); $s
```

- `MERGED`: siga para a fase 2 sem perguntar de novo, porque o merge foi a aprovação.
- `CLOSED`: a PR foi fechada sem merge. Não publique nada. Avise o usuário e, se ele quiser,
  apague a branch `release/v<versão>`.
- Se o comando parar sem resposta (por exemplo, porque a sessão foi encerrada), o usuário
  retoma rodando `/release` depois do merge.

Não acompanhe os checks de CI do merge: eles só testam. A release roda os testes de novo
antes de gerar o instalador.

## 3. Fase 2: publicar a release (versão já em `main`)

Rode `git fetch origin --tags --quiet` e o `next-version.mjs` de novo (com `--notes-out`). Use
a `tag`, o `channel` e as `notes` de `pendingOnMain`: os commits `release(...)` ficam de fora
das notas, e o link de comparação já aponta para a nova tag.

Se a fase 2 começou numa nova execução de `/release` (e não logo depois da espera do merge),
mostre a tag e as notas e pergunte com `AskUserQuestion`. As opções são "Publicar", "Criar
como rascunho" e "Cancelar".

Crie a tag no commit do merge da PR de versão, e não num `main` que pode ter andado:

```powershell
$sha = gh pr view <número> --json mergeCommit -q .mergeCommit.oid   # ou: git log -1 --format=%H --grep '^release(' origin/main
gh release create v<versão> --target $sha --title v<versão> --notes-file "<scratchpad>\release-notes.md" <flags>
```

- alpha ou beta: `--prerelease`
- stable: `--latest`
- rascunho: acrescente `--draft`. O workflow só roda quando a release for publicada.

Não escreva a seção de downloads nas notas: o workflow a acrescenta depois de anexar o
instalador.

Depois, passe ao usuário o link da release e o run do workflow, sem ficar acompanhando o
build:

```powershell
gh run list --workflow windows.yml --event release --limit 1
```
