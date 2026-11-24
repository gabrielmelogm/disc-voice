# Disc Voice — Documentação

> 🎧 **Apresentação, download e instalação:** volte ao [README](README.md).

Aplicativo com Tauri 2, React, TypeScript e Rust. Contas, servidores com convites, mensagens persistidas, canais de voz WebRTC e configurações de microfone, saída de áudio e webcam. Interface em português.

## Contas, servidores e banco de dados

O backend em `apps/api` usa **Axum + SeaORM + PostgreSQL**. O desktop e a versão web acessam a mesma API HTTP; credenciais do PostgreSQL ficam no backend. A infraestrutura Docker fica em `infra/docker`.

Com Docker e Node.js instalados, na raiz:

```powershell
Copy-Item .env.example .env
npm ci
npm run services:up
```

No Linux, use `cp .env.example .env`. O comando `services:up` compila a API e a interface web, inicia PostgreSQL e aplica as migrações automaticamente. Abra **http://localhost:3001** para usar a versão web.

1. Clique em **Continuar com Google** (veja [Login com Google](#login-com-google)); a conta é criada no primeiro acesso.
2. Clique em **Criar meu servidor** ou no **+** da lateral e informe um nome.
3. Copie o convite exibido. Ele também está disponível em **Convidar amigos**.
4. Outra pessoa pode abrir o link no navegador, entrar/cadastrar-se e **Aceitar convite**, ou colá-lo em **Entrar em servidor** no app.
5. Dentro do servidor, clique em **Criar canal**, escolha **Texto** ou **Voz** e informe o nome. Qualquer membro pode criar canais; nomes são únicos dentro de cada servidor.
6. O botão de fones na lateral abre **Voz e vídeo**.

Os canais criados por outros membros aparecem em tempo real. Canais de texto têm envio de mensagens e histórico persistido, com carregamento das mensagens anteriores. Enter envia; Shift+Enter insere uma quebra de linha. Mensagens com falha podem ser reenviadas sem duplicação.

## Canais de voz e tempo real

Selecione um canal de voz e clique em **Entrar no canal de voz**. Autorize o microfone. Os participantes aparecem na lateral; durante a chamada, a interface indica quem está falando. Os controles permitem silenciar o microfone, desativar o áudio recebido (também silencia a transmissão) e sair.

A chamada continua enquanto você navega nos canais de texto, servidores e configurações. Cada conta participa de uma chamada por vez: entrar por outra aba/dispositivo substitui a participação anterior. Logout, fechamento e expiração de sessão encerram a participação. Ao perder a sinalização, o cliente libera os dispositivos e tenta entrar novamente após reconectar. O botão de sair cancela essa tentativa.

Em **Voz e vídeo → Dispositivos das chamadas**, escolha o microfone e a saída WebRTC. Essas preferências são salvas localmente. A saída usa `setSinkId` quando suportado; nos demais ambientes, usa a saída padrão do sistema. Os IDs do navegador são diferentes dos IDs CPAL/PulseAudio dos testes locais, por isso as seleções são explícitas. No aplicativo Linux, as listas vêm do motor de chamadas e usam os nomes do PulseAudio; um dispositivo salvo que sumiu cai no padrão do sistema. Os testes locais de áudio ficam desabilitados durante chamadas.

### Arquitetura

- A API Axum fornece `/api/realtime` via WebSocket autenticado no primeiro frame, sem token na URL. Ela distribui mensagens, presença e sinalização SDP/ICE.
- Mensagens são gravadas no PostgreSQL antes da publicação. O cliente usa `clientId` para reenvio idempotente e cursores para recuperar lacunas após quedas.
- O áudio trafega por **WebRTC em malha ponto a ponto**, com uma conexão por par de participantes. A API não transporta áudio. O padrão é **8 participantes por canal**, configurável em `VOICE_CHANNEL_CAPACITY` (2–32); consumo de upload e CPU cresce com o tamanho do grupo.
- A presença é efêmera e mantida na memória de **uma instância da API**. Ao reiniciar, clientes reconectam e sincronizam os canais. Executar múltiplas réplicas exige uma camada compartilhada de presença/sinalização.
- No navegador e no Windows (WebView2), a chamada usa o WebRTC da própria página.
- No Linux, o WebKitGTK das distribuições vem compilado **sem WebRTC** (há `getUserMedia`, mas não `RTCPeerConnection`), então a chamada roda no motor nativo `packages/call-engine` (`disc-call`): webrtc-rs com uma conexão por participante, microfone e saída pelo PulseAudio/PipeWire, voz em Opus e telas em H.264 (OpenH264, compilado junto). A interface só repassa a sinalização (as mesmas mensagens `voice.signal`) e desenha as telas recebidas como quadros JPEG. Por isso, clientes Linux, Windows e navegador conversam entre si.
- O motor nativo ainda não tem cancelamento de eco nem supressão de ruído (o navegador tem): no Linux, prefira fones de ouvido. Para receber a tela de um cliente Linux, o navegador precisa decodificar H.264 (Chrome, Edge e o WebView2 decodificam; Chromium de algumas distribuições e Firefox sem o OpenH264 não).

### STUN e TURN

No mesmo computador, use `localhost`. Entre computadores, publique a interface/API por **HTTPS** e permita o upgrade de **WebSocket/WSS** no proxy reverso. `VITE_API_URL` define também o endereço da sinalização.

STUN ajuda a descobrir endereços acessíveis. Algumas redes exigem **TURN**, que retransmite o áudio quando a conexão direta falha. O Compose inclui Coturn no perfil `voice`. Configure na raiz:

```dotenv
VOICE_CHANNEL_CAPACITY=8
STUN_URL=stun:stun.l.google.com:19302
TURN_URLS=turn:voz.exemplo.com:3478?transport=udp,turn:voz.exemplo.com:3478?transport=tcp
TURN_SECRET=<segredo-aleatorio-longo>
TURN_EXTERNAL_IP=<ip-publico-do-host-coturn>
```

Use o mesmo segredo na API e no Coturn. A API gera credenciais TURN temporárias por usuário (24 horas); o segredo não é enviado ao cliente. Gere um segredo, por exemplo, com `openssl rand -hex 32`.

```sh
docker compose --profile voice up --build -d
```

Publique **3478/TCP**, **3478/UDP** e **49160–49200/UDP** no host/firewall/NAT, preservando os números das portas. O DNS `voz.exemplo.com` deve apontar ao host Coturn; não passa pelo proxy HTTP da API. O perfil fornecido oferece TURN UDP/TCP; para redes que exigem TURN sobre TLS/443, configure um serviço TURN TLS e forneça a URL `turns:` em `TURN_URLS`.

Sem `TURN_URLS`, o cliente usa apenas STUN/conexões diretas. Testar em `localhost` não comprova conectividade entre redes diferentes.

### Contratos HTTP de chat

- `POST /api/servers/:id/channels`: `{ "name": "geral", "type": "text" | "voice" }`. A omissão de `type` assume `text` por compatibilidade.
- `GET /api/channels/:id/messages?before=<id>&limit=50`: histórico anterior. Para recuperar mensagens novas, use `after=<id>`, sem `before`. Limite máximo: 100.
- `POST /api/channels/:id/messages`: `{ "clientId": "<uuid>", "content": "Olá!" }`. De 1 a 4000 caracteres; repetir o mesmo envio retorna a mesma mensagem.
- `GET /api/voice/config`: configuração ICE autorizada para a sessão.
- `PATCH /api/me`: `{ "name": "Ana", "pronouns": "ela/dela", "bio": "Sobre mim", "banner": "brand" }`. Todos os campos são opcionais; só os enviados mudam. Nome de 1 a 32 caracteres (mesma regra do cadastro), pronomes até 40, “Sobre mim” até 190 (aceita quebras de linha) e `banner` entre `brand`, `green`, `amber`, `red` e `graphite`. A mudança é enviada como `user.updated` pelo tempo real para os membros dos mesmos servidores e para os outros dispositivos da conta; as salas de voz recebem um novo `voice.participants` com o nome atualizado.
- `GET /api/search?q=<texto>&before=<id>`: busca global (Ctrl+K). Retorna `channels` (canais e salas pelo nome), `people` (pessoas que compartilham algum servidor com você) e `messages` (conteúdo, com índice de texto completo `messages_search` e busca por prefixo), sempre restritos aos servidores de que você participa. As mensagens vêm da mais nova para a mais antiga, 20 por página; passe `nextCursor` como `before` para a próxima página (que traz só mensagens). `q` deve ter de 1 a 100 caracteres.

Todos exigem sessão; operações nos canais exigem associação ao servidor e o tipo correto de canal.

O login é feito somente com Google. A sessão é revogável e continua ativa ao fechar e reabrir o app: o token fica no `localStorage` do cliente. Ela expira após 30 dias sem uso, e cada uso renova esse prazo. Sair da conta revoga a sessão no servidor. O banco guarda somente o hash do token. Servidores, membros, convites e canais ficam no PostgreSQL. Convites são reutilizáveis, sem expiração nesta versão; aceitar o mesmo convite duas vezes não duplica a associação.

Para parar os serviços mantendo os dados:

```powershell
npm run services:down
```

### Temas personalizados

Em **Configurações → Temas** é possível importar um tema por arquivo `.json` (arrastando ou escolhendo o arquivo, até 200 KB) ou por um link público `https://` (o servidor precisa permitir CORS, como o GitHub raw ou um Gist). Formato:

```json
{ "name": "Aurora", "author": "Gabi Nunes", "base": "dark", "colors": { "brand": "#1fb5a3", "surface": "#0f1d24" } }
```

`base` é `light` ou `dark`; as cores usam os nomes dos tokens do design system (lista em `apps/desktop/src/lib/theme.ts`, que deve acompanhar `styles.css`) no formato `#rrggbb` ou `#rgb`. O que faltar vem da base. Campos, nomes de cor ou valores desconhecidos rejeitam o arquivo sem mudar o tema atual. Cores de texto abaixo de 4,5:1 de contraste com seus fundos são ajustadas na importação, e a tela informa quais foram. Os temas e a escolha ficam no `localStorage` e valem após reiniciar o app.

### Desenvolvimento da API

`npm run dev:api` sobe apenas o PostgreSQL no Docker (aguardando o healthcheck) e executa a API localmente:

```powershell
npm run dev:api
```

Em outro terminal, execute `npm run dev:web` ou `npm run dev` no Windows. O Vite encaminha `/api` para `http://127.0.0.1:3001`; o desktop usa essa API local por padrão. O `.env` da raiz é lido pela API e pelo Vite. A API serve o conteúdo de `apps/desktop/dist` quando disponível (`npm run build`).

Para iniciar somente o banco (por exemplo, antes de executar `cargo run` diretamente), use `npm run db:up`.

Não execute a API local e o container da API ao mesmo tempo: ambos usam a porta 3001. PostgreSQL usa a porta local 5433, configurável por `POSTGRES_PORT`. Se alterar usuário/senha/porta, ajuste também `DATABASE_URL` para execução local.

### Desenvolvimento no WSL ou Linux

No WSL/Linux, `npm run dev:api` usa o toolchain Linux do Rust e precisa das bibliotecas de desenvolvimento do sistema. Se o build falhar com `cannot open Scrt1.o`, `cannot open crti.o` ou `unable to find library -lc`, instale:

```bash
sudo apt update
sudo apt install -y build-essential pkg-config
```

Depois execute novamente:

```bash
npm run dev:api
```

Sem acesso a `sudo`, use o Docker, que já contém o toolchain e as bibliotecas necessárias:

```bash
npm run services:up
```

A API e a interface web ficam em **http://localhost:3001**. Nesse caso, não rode `npm run dev:api` ao mesmo tempo.

No WSL, use `npm run dev:web` para visualizar a interface no navegador. No Linux com desktop, o aplicativo nativo também roda (veja abaixo).

### Executar no Linux

O áudio nativo usa a API do PulseAudio, atendida pelo PipeWire (`pipewire-pulse`) nas distribuições atuais. A webcam também é capturada pelo motor nativo, pelo portal de câmera (`xdg-desktop-portal`) e PipeWire via GStreamer: a captura do próprio WebKitGTK corrompe os quadros do PipeWire. O teste de compartilhamento de tela segue o mesmo caminho, pelo portal ScreenCast, que abre o seletor de telas e janelas do próprio desktop (GNOME, KDE, wlroots). Instale as bibliotecas de desenvolvimento do Tauri, do PulseAudio e do GStreamer:

```bash
# Fedora (em sistemas imutáveis, como Silverblue/Kinoite, dentro de um toolbox/distrobox)
sudo dnf install -y pulseaudio-libs-devel webkit2gtk4.1-devel libsoup3-devel gtk3-devel librsvg2-devel \
  gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-good pipewire-gstreamer cmake gcc-c++

# Debian/Ubuntu
sudo apt install -y libpulse-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev librsvg2-dev build-essential pkg-config \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-good gstreamer1.0-pipewire cmake
```

O `cmake` e o compilador C++ compilam o Opus e o OpenH264 usados pelo motor de chamadas. Depois execute `npm run dev` para desenvolvimento ou `npm run build:linux` para gerar `.deb` e `.rpm` em `target/release/bundle/`.

Os testes do backend PulseAudio usam um *null sink*, sem tocar alto-falantes nem microfone:

```bash
pactl load-module module-null-sink sink_name=disc_voice_test
cargo test -p disc-audio -- --ignored pulse
pactl unload-module module-null-sink
```

O teste da webcam usa a câmera real pelo portal e descarta os quadros (nada é gravado nem exibido):

```bash
cargo test -p disc-video -- --ignored pipewire::
```

A captura de tela pode ser validada sem o app. O teste abaixo lê um nó de vídeo PipeWire local pelo mesmo pipeline do app (redimensionamento, limite de quadros e JPEG). Crie o nó em um terminal e passe o ID dele (veja com `pw-dump`) em outro:

```bash
gst-launch-1.0 videotestsrc is-live=true ! video/x-raw,format=BGRx,width=2560,height=1440,framerate=60/1 \
  ! pipewiresink mode=provide stream-properties="props,node.name=discvoice-test,media.class=Video/Source"
DISCVOICE_TEST_NODE=<id> DISCVOICE_TEST_FPS=30 cargo test -p disc-video -- --ignored scales_and_throttles
```

Para passar pelo portal de verdade, `cargo run -p disc-video --example screen_probe 20` abre o seletor do sistema, informa o que foi compartilhado e quantos quadros chegaram, e encerra depois de 20 s (fechando o seletor se ele ainda estiver aberto).

### Se a API não conectar ao PostgreSQL

O erro `PoolTimedOut` significa que a API não conseguiu abrir conexão com o banco dentro do tempo limite. Verifique, nesta ordem:

1. O **Docker Desktop** está aberto e o comando `docker compose ps` mostra o serviço `db` como `healthy`.
2. Inicie o banco e aguarde o healthcheck: `npm run db:up`.
3. Confira no `.env` se `DATABASE_URL` usa a mesma porta e senha de `POSTGRES_PORT` e `POSTGRES_PASSWORD`. O padrão é `127.0.0.1:5433`.
4. Veja os logs do banco: `docker compose logs db`.
5. Se a porta 5433 já estiver em uso, altere `POSTGRES_PORT` e `DATABASE_URL` juntos no `.env`.

Se você executou `npm run services:up`, a API já está rodando no container: acesse **http://localhost:3001** em vez de rodar `npm run dev:api`, pois os dois usam a porta 3001.

### Convites entre computadores

Publique a API e a interface web em uma origem HTTPS acessível aos participantes. Configure:

```dotenv
PUBLIC_WEB_URL=https://comunidade.exemplo.com
CORS_ORIGINS=https://comunidade.exemplo.com,https://tauri.localhost,http://tauri.localhost,tauri://localhost
VITE_API_URL=https://comunidade.exemplo.com/api
```

`PUBLIC_WEB_URL` define os links de convite; `PUBLIC_WEB_URL` é sempre aceita como origem (HTTP e WebSocket `/api/realtime`); `CORS_ORIGINS` acrescenta as demais, como o Tauri. `VITE_API_URL` é incorporada ao **compilar o desktop**, portanto configure-a antes de gerar o instalador. O frontend web do Docker usa `/api` na própria origem. Termine HTTPS no proxy reverso que encaminha para a porta 3001. Configure também uma senha própria para o banco em `POSTGRES_PASSWORD`.

Os links são convites web; no desktop, use **Entrar em servidor** para colar o link. Links `localhost` servem somente para uso no mesmo computador.

### Login com Google

O login é feito somente com Google (OAuth 2.0 com PKCE). O app obtém um código de autorização e a API o troca pelo token no Google, com o segredo do cliente, que fica apenas na API. Contas antigas, criadas com e-mail e senha, são vinculadas automaticamente pelo e-mail verificado no primeiro login.

No [Google Cloud Console](https://console.cloud.google.com), em **Google Auth Platform**:

1. **Branding**: nome do app, e-mail de suporte e domínio autorizado (ex.: `exemplo.com`).
2. **Audience**: tipo **External**. Em modo *Testing*, adicione as contas em *Test users*; para liberar a todos, use **Publish app**. Os escopos `openid email profile` não exigem verificação.
3. **Clients**, criar dois clientes:
   - **App para computador** (Desktop app): não precisa de URI de redirecionamento, pois o Google aceita qualquer `http://127.0.0.1:<porta>`.
   - **Aplicativo da Web**: em *Origens JavaScript autorizadas*, coloque `https://comunidade.exemplo.com` e `http://localhost:1420`. Em *URIs de redirecionamento autorizados*, coloque `https://comunidade.exemplo.com/auth/google/callback` e `http://localhost:1420/auth/google/callback`.

```dotenv
GOOGLE_DESKTOP_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_DESKTOP_CLIENT_SECRET=...
GOOGLE_WEB_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_WEB_CLIENT_SECRET=...
```

Se o cliente da plataforma (desktop ou web) não estiver configurado, **Continuar com Google** mostra um aviso em vez de abrir o login.

### Integração com o Discord

Duas funções usam o mesmo aplicativo do Discord (somente leitura):

- **Importar canais** (dono do servidor, botão **Importar do Discord** na barra de canais): instala o bot em um servidor do Discord e traz o histórico de canais de texto para canais do Disc Voice, **uma vez**. O histórico é importado do mais antigo para o mais novo, 100 mensagens por requisição (`after=<último id>`), com autor, data e texto; menções por id (`<@123>`, `<#456>`, emojis próprios) viram texto legível. Enquanto importa, o canal fica bloqueado para envio, para as mensagens novas não se misturarem ao histórico. Ao terminar, ele vira um canal comum do Disc Voice, e mensagens enviadas depois no Discord não são trazidas. Mensagens nunca se repetem (`discord_id` único por canal), limites de requisição (429 e `X-RateLimit-*`) são respeitados com nova tentativa, e falhas de permissão aparecem no diálogo com **Tentar de novo** ou **Concluir com o que já foi importado**.
- **Mídias importadas**: os links de anexos do Discord expiram, então imagens, vídeos e arquivos de até 25 MB são copiados para a API (`UPLOADS_DIR`, no Docker o volume `api-uploads`) e servidos em `/api/files/<id>/<nome>`. O link é aleatório, como na CDN do Discord: quem tem o link abre o arquivo. Imagens, vídeo e áudio aparecem no app com prévia e visualizador; outros tipos baixam, e nenhum arquivo servido executa scripts (`Content-Security-Policy: sandbox`, `nosniff`). Anexos maiores ou com link já expirado ficam como cartão com o link original.
- **Atividade** (cada pessoa, em **Configurações → Conexões**): vincula a conta do Discord (escopo `identify`) e mostra no perfil o que ela está jogando, ouvindo ou assistindo. O Discord não entrega a atividade de outros apps por OAuth; ela vem do bot (intent `GUILD_PRESENCES`), então só aparece para quem está em algum servidor do Discord que tenha o bot. A pessoa pode desligar o compartilhamento a qualquer momento. As atividades ficam só em memória e vão apenas para quem compartilha um servidor com ela (evento `activity.updated`, `GET /api/activities`). A miniatura (capa do Spotify, arte do jogo, vídeo do YouTube) vem de `assets` da presença; jogos detectados sem imagem própria usam o ícone do aplicativo (`GET /applications/<id>/rpc`, guardado em memória). O app carrega essas imagens direto das CDNs do Discord, Spotify, YouTube e Twitch.
- **No Discord, “Em um canal de voz”** (Rich Presence, opção em **Configurações → Conexões**, ligada por padrão): enquanto a pessoa está numa sala de voz, o app desktop mostra no perfil dela no Discord “Disc Voice · Em um canal de voz · <sala> · <servidor>” com o tempo decorrido. A API do Discord não deixa um app definir a presença de outra pessoa, então isso usa o socket local do cliente Discord (`discord-ipc-N`: pipe nomeado no Windows, socket Unix no Linux, incluindo Flatpak e Snap) com o mesmo *Client ID* (exposto em `GET /api/discord` como `clientId`). Só funciona com o Discord desktop aberto no mesmo computador; se ele abrir depois, o app tenta de novo a cada 15 s. A API ignora essa atividade ao ler a presença, para o perfil no Disc Voice não mostrar “Jogando Disc Voice”.

No [Discord Developer Portal](https://discord.com/developers/applications), crie um aplicativo:

1. **OAuth2 → Redirects**: adicione `<PUBLIC_WEB_URL>/api/discord/callback` (ex.: `https://comunidade.exemplo.com/api/discord/callback` e, localmente, `http://localhost:3001/api/discord/callback`). Copie *Client ID* e *Client Secret*.
2. **Bot**: gere o token. Em *Privileged Gateway Intents*, ative **Presence Intent** (atividades) e **Message Content Intent** (sem ele as mensagens importadas chegam sem texto). Acima de 100 servidores, o Discord exige verificação para manter essas intents.
3. O bot pede só **Ver canal** e **Ler histórico de mensagens**. Canais com permissões próprias que escondem o bot aparecem como “Sem permissão para ler”.
4. **Rich Presence → Art Assets**: envie a logo do Disc Voice (512×512) com o nome `logo`. O nome do aplicativo no portal é o que aparece em “Jogando …”, então use **Disc Voice**.

```dotenv
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_BOT_TOKEN=...
```

Sem essas três variáveis a integração fica desativada e a interface avisa. A API mantém uma única conexão de gateway; rode só uma instância da API com o bot configurado.

Canais de texto e de voz podem ter o mesmo nome (ex.: `geral` de texto e `geral` de voz); dois canais do mesmo tipo, não.

## Executar no Windows

Instale:

- **Node.js 22.12+** (recomendado: 24 LTS), com npm.
- **Rust stable**, toolchain `x86_64-pc-windows-msvc`, via [rustup](https://rustup.rs/).
- **Visual Studio Build Tools 2022**, com “Desenvolvimento para desktop com C++” e Windows SDK.
- **Microsoft Edge WebView2 Runtime** (já incluído na maioria das instalações do Windows 10/11).
- **Docker** com Docker Compose v2.20 ou superior, para executar a API e PostgreSQL com `npm run services:up`.

Na raiz do projeto, em PowerShell:

```powershell
npm ci
npm run services:up
npm run dev
```

Para gerar o instalador NSIS:

```powershell
npm run build:windows
```

O `.exe` fica em `target/release/bundle/nsis/`. O instalador baixa o WebView2 caso necessário, portanto essa etapa precisa de internet se o runtime estiver ausente.

### Compartilhamento de tela no Windows

A tela é capturada pelo motor nativo (`packages/video-engine/src/wgc.rs`) com **Windows.Graphics.Capture**: o seletor do próprio Windows escolhe a tela ou janela, os quadros chegam como texturas Direct3D 11, são reduzidos e codificados em JPEG pelo WIC em uma thread separada. Requer Windows 10 versão 1903 ou mais recente; esconder o cursor exige a versão 2004 e remover a borda amarela de captura exige o Windows 11 (nas versões anteriores a borda continua aparecendo). O seletor não informa se foi escolhida uma tela ou uma janela, então a fonte aparece como “Fonte do sistema”.

Sem o app, `cargo run -p disc-video --example screen_probe 20` abre o seletor a partir do terminal e informa quantos quadros chegaram. `cargo test -p disc-video -- --ignored captures_valid_jpeg_frames_from_the_primary_monitor` captura o monitor principal por 3 s sem passar pelo seletor (os quadros são descartados).

## Testes de dispositivos

1. **Microfone:** selecione uma entrada e clique em **Testar microfone**. O medidor exibe o pico capturado e seu nível em dBFS. Fale por até 10 segundos; também é possível finalizar antes.
2. **Saída:** selecione a saída física, ajuste o volume do teste e clique em **Tocar som**. Um tom suave de 440 Hz toca por 3 segundos em todos os canais da saída. **Ouvir gravação** reproduz o último trecho capturado nesse mesmo dispositivo.
3. **Webcam:** selecione uma câmera e clique em **Testar webcam**. Aceite a permissão do WebView2. A prévia mostra resolução e taxa de quadros reportadas pela câmera, com opção de espelhamento.
4. **Tela (Windows e Linux):** escolha a resolução máxima, a taxa de quadros e se o cursor aparece, clique em **Compartilhar tela** e selecione uma tela ou janela no seletor do sistema. A prévia mostra a fonte, o tamanho real dos quadros e os fps recebidos. Uma tela parada envia menos quadros. **Cancelar** fecha o seletor, e encerrar o compartilhamento pelo indicador do desktop também encerra o teste.
5. **Atualizar dispositivos** refaz a enumeração. Eventos `devicechange` também atualizam as listas quando disponibilizados pelo WebView2. Desconexões durante a captura são tratadas.
6. **Encerrar todos os testes** libera os dispositivos. Fechar o app também encerra os streams.

A webcam não captura áudio. Antes da primeira permissão, o WebView2 pode ocultar nomes e câmeras; use a câmera padrão para autorizar e atualizar a lista. Se o acesso falhar, habilite câmera/microfone para **aplicativos da área de trabalho** em Configurações do Windows → Privacidade e segurança.

A gravação fica **somente na memória**, é substituída na próxima captura e descartada ao fechar o aplicativo. O volume controla apenas a reprodução do teste, sem alterar o volume do Windows. Captura de microfone e reprodução de áudio são mutuamente exclusivas para evitar gravar o próprio som de teste.

## Estrutura

```text
apps/
  api/                  API Rust, autenticação, SeaORM e migrações PostgreSQL
  desktop/
    src/                React, contas, servidores, canais, dispositivos e testes
    src-tauri/          Janela Tauri, comandos IPC, configuração Windows
    scripts/            Verificação da plataforma
packages/
  shared/               Contratos TypeScript da API e IPC
  audio-engine/         Motor Rust: WASAPI/CPAL, gravação e reprodução
infra/docker/           Dockerfile da API/web e Compose com PostgreSQL
compose.yaml            Entrada do Compose na raiz, para carregar o .env
public/                 Identidade visual e ícone da aplicação
.github/workflows/      Testes e build do instalador no Windows
```

- npm workspaces organizam os pacotes JavaScript; Cargo workspace organiza os crates Rust.
- `public/icon.png` é a arte original; `public/app-icon.png` é o ícone arredondado com cantos transparentes usado na interface e no favicon. Os PNG/ICO em `apps/desktop/src-tauri/icons` e `source.svg` são derivados dessa arte para janela, executável e instalador.
- Áudio usa **CPAL/WASAPI**, inclusive a reprodução na saída selecionada. Não depende de `HTMLMediaElement.setSinkId`.
- O motor mantém os dispositivos em uma thread dedicada. A identidade dos endpoints WASAPI preserva seleções mesmo com nomes iguais ou mudanças na ordem da enumeração.
- PCM mono é limitado a 10 segundos e reamostrado na reprodução quando as taxas dos dispositivos diferem.
- Webcam usa `getUserMedia` no **WebView2**, com contexto HTTPS no app empacotado. Respostas tardias de permissão são descartadas e seus tracks liberados.

## Desenvolvimento e testes automatizados

```powershell
npm run check        # TypeScript, Vitest e build da interface
npm run test:rust    # Testes de todos os crates
npm run test:audio   # Apenas os testes de processamento de áudio
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
```

Os testes cobrem seleção e troca de dispositivos, comandos IPC, erros, liberação da webcam, cancelamento de permissões pendentes, estados de captura, limite da gravação, reamostragem e geração do tom. Também verificam reenvio idempotente de mensagens, recuperação de lacunas e liberação do microfone durante cancelamento/reconexão. Hardware real não é necessário para esses testes.

Também há testes da interface para login com Google, criação de servidor/canal, cópia de convite, entrada após login, sessão expirada e logout.

Os testes de integração da API usam PostgreSQL real. Aponte `TEST_DATABASE_URL` para um banco de teste e execute:

```powershell
$env:TEST_DATABASE_URL = "postgres://discvoice:discvoice_local@127.0.0.1:5433/discvoice"
npm run test:api
```

No Linux: `TEST_DATABASE_URL=postgres://discvoice:discvoice_local@127.0.0.1:5433/discvoice npm run test:api`. O teste cria registros únicos e remove apenas seus próprios registros ao finalizar. Verifica hash de senha/token, login, conflitos, migrações idempotentes, permissões entre usuários e servidores, convites inválidos/repetidos, criação e persistência de canais, expiração e revogação de sessão. O workflow `API` executa esse teste com um PostgreSQL dedicado; `cargo test --workspace` ignora o teste que exige banco.

O workflow `Windows` executa as verificações, compila o aplicativo e publica o instalador como artefato de CI.

### Prévia da interface

```sh
npm run dev:web
```

Abra `http://127.0.0.1:1420`. Essa prévia também funciona no Linux, mas o **áudio nativo só funciona no aplicativo Windows**. As listas de áudio não são simuladas. A webcam da prévia depende das permissões do navegador.

### Validação manual no Windows

- Criar duas contas, criar um servidor, criar um canal e entrar pelo convite em outro app/navegador.
- Testar entrada e saída integradas e USB, incluindo dois dispositivos com nomes iguais.
- Ouvir o tom e a gravação em uma saída diferente da saída padrão do Windows.
- Desconectar um dispositivo durante o teste e atualizar a lista.
- Negar a permissão da webcam, tentar novamente, cancelar enquanto a permissão está pendente e trocar de câmera.
- Confirmar que o indicador da webcam apaga ao parar ou fechar o app.
- Instalar o `.exe` e repetir os testes na versão empacotada, além de `npm run dev`.

### Validação manual do chat

- Com três contas no mesmo servidor, enviar mensagens, carregar histórico, reconectar e confirmar ausência de duplicações.
- Entrar no mesmo canal de voz e confirmar áudio bidirecional entre todos, indicadores de fala, mute e áudio recebido desativado.
- Navegar para texto/configurações mantendo a chamada; trocar microfone/saída e trocar de canal.
- Negar acesso ao microfone, desconectá-lo, fechar uma aba, fazer logout e abrir a mesma conta em outra aba.
- Interromper a rede e confirmar reconexão, remoção de participantes inativos e liberação dos dispositivos.
- Repetir em duas redes distintas; verificar uso do candidato `relay` nas estatísticas WebRTC quando TURN for necessário.
- Repetir no Tauri empacotado para Windows e Linux, usando dispositivos reais.

### Validação manual do compartilhamento de tela na chamada

Na chamada, o botão de tela (ao lado do microfone) abre o seletor do sistema e envia a tela a todos os participantes como vídeo WebRTC nas mesmas conexões do áudio (até 1920 × 1080, 30 fps, ~2,5 Mbps por participante). Quem compartilha aparece com o ícone de tela na lista; as telas recebidas ficam acima dos participantes (clique em ampliar, ou duplo clique para tela cheia). O motor tem uma captura só: iniciar o teste das configurações encerra o compartilhamento da chamada e vice-versa.

- Com duas contas (Windows ↔ Windows e Windows ↔ Linux) no mesmo canal, compartilhar uma tela e uma janela; o outro lado deve ver o vídeo e o ícone.
- Cancelar o seletor; parar o compartilhamento; fechar a janela compartilhada (deve aparecer “O compartilhamento de tela foi encerrado.”).
- Entrar no canal com a tela já sendo compartilhada: o novo participante deve recebê-la.
- Sair do canal compartilhando: o indicador/borda do sistema deve sumir.

Os testes automatizados não substituem essa verificação com drivers e hardware reais.
