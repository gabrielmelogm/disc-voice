<p align="center">
  <img src="public/icon.png" alt="Logo do Disc Voice" width="170" />
</p>

<h1 align="center">Disc Voice</h1>

<p align="center">
  <strong>Seu espaço para amigos e comunidades.</strong><br />
  Crie servidores, converse por canais de texto e cuide do seu áudio e vídeo —<br />
  tudo em português e direto no seu Windows ou Linux.
</p>

<p align="center">
  <a href="https://github.com/gabrielmelogm/disc-voice/releases"><img src="https://img.shields.io/badge/Baixar%20para%20Windows-0.1.0--alpha.2-6410c9?style=for-the-badge&amp;logo=windows11&amp;logoColor=white" alt="Baixar para Windows" /></a>
  <a href="https://github.com/gabrielmelogm/disc-voice/releases"><img src="https://img.shields.io/badge/Baixar%20para%20Linux-AppImage-6410c9?style=for-the-badge&amp;logo=linux&amp;logoColor=white" alt="Baixar para Linux (AppImage)" /></a>
  <a href="DOCS.md"><img src="https://img.shields.io/badge/Documenta%C3%A7%C3%A3o-DOCS.md-262032?style=for-the-badge&amp;logo=readthedocs&amp;logoColor=white" alt="Documentação" /></a>
  <a href="https://github.com/gabrielmelogm/disc-voice/issues/new"><img src="https://img.shields.io/badge/Reportar%20bug-Abrir%20issue-f397aa?style=for-the-badge&amp;logo=github&amp;logoColor=14111c" alt="Reportar bug" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/vers%C3%A3o-0.1.0--alpha.2-6410c9?style=flat-square" alt="Versão 0.1.0-alpha.2" />
  <img src="https://img.shields.io/badge/Windows-10%2F11%20x64-0078D4?style=flat-square&amp;logo=windows11&amp;logoColor=white" alt="Windows 10/11 x64" />
  <img src="https://img.shields.io/badge/Linux-AppImage%20x86__64-FCC624?style=flat-square&amp;logo=linux&amp;logoColor=black" alt="Linux AppImage x86_64" />
  <img src="https://img.shields.io/badge/Web-navegador-a66bf4?style=flat-square&amp;logo=googlechrome&amp;logoColor=white" alt="Web no navegador" />
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&amp;logo=tauri&amp;logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&amp;logo=react&amp;logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/Rust-stable-000000?style=flat-square&amp;logo=rust&amp;logoColor=white" alt="Rust" />
</p>

---

## 🎧 Um lugar para a sua comunidade

O **Disc Voice** reúne contas, servidores com convites, canais de texto e ferramentas
de voz e vídeo em um aplicativo desktop feito com **Tauri 2, React, TypeScript e Rust**.
A interface é toda em português e o áudio nativo usa **WASAPI/CPAL** no Windows e
**PulseAudio/PipeWire** no Linux para funcionar de verdade com seus dispositivos.

| | |
|:--|:--|
| 👤 **Contas e sessões** | Login com **Google** (OAuth 2.0 com PKCE). Sessão revogável que continua ativa ao reabrir o app e expira após 30 dias sem uso. |
| 🏠 **Servidores e convites** | Crie seu servidor, compartilhe um convite e entre em comunidades pelo link ou pelo app. |
| 💬 **Canais de texto** | Mensagens em tempo real, histórico no PostgreSQL e reenvio sem duplicação. |
| 🎧 **Canais de voz** | Chamadas WebRTC ponto a ponto, participantes ao vivo, mute, controle de áudio recebido e reconexão. |
| 🎙️ **Microfone** | Teste a entrada, veja o pico capturado e o nível em **dBFS** antes de entrar em uma conversa. |
| 🔊 **Saída de áudio** | Toque um tom de 440 Hz na saída escolhida e ouça a última gravação no mesmo dispositivo. |
| 📷 **Webcam** | Prévia com resolução, taxa de quadros e opção de espelhamento, com permissões tratadas no WebView2 (Windows) ou pelo portal de câmera (Linux). |

Ao criar um canal, escolha **Texto** ou **Voz**. As chamadas continuam enquanto você navega pela comunidade. Para conectar participantes em redes diferentes, consulte a [configuração de STUN/TURN](DOCS.md#stun-e-turn).

---

## 🖥️ Plataformas e instalação

**Versão atual:** `0.1.0-alpha.2`

| Plataforma | Instalação | Disponibilidade |
|:--|:--|:--|
| **Windows 10/11 (x64)** | Instalador **`.exe` (NSIS)** | ✅ App completo |
| **Linux (x86_64)** | **AppImage**, sem instalação | ✅ App completo (novo) |
| **Web** | Nenhuma — abra no navegador | ✅ Mesma conta e servidores |
| **macOS** | Nenhuma — use a versão web | ⚠️ Sem aplicativo nativo |

> [!IMPORTANT]
> O aplicativo desktop existe para **Windows 10/11 de 64 bits** e **Linux x86_64**. No Linux,
> webcam e compartilhamento de tela passam pelos portais do sistema (PipeWire) e o áudio pelo
> PulseAudio/PipeWire. No macOS, use a versão web.

### Instalar no Windows

1. **Baixe o instalador** `DiscVoice_0.1.0-alpha.2_x64-setup.exe` na página de
   [Releases](https://github.com/gabrielmelogm/disc-voice/releases) ou pelo botão de download
   do [site](https://get-discvoice.devgabrielmelo.shop). O arquivo `SHA256SUMS` da release
   serve para conferir o download.
2. **Execute o `.exe`** e siga o assistente de instalação. O WebView2 é baixado
   automaticamente caso ainda não esteja presente.
3. **Abra o Disc Voice**, crie sua conta e comece a montar sua comunidade.

### Usar no Linux

1. **Baixe o AppImage** `DiscVoice_0.1.0-alpha.2_x86_64.AppImage` na página de
   [Releases](https://github.com/gabrielmelogm/disc-voice/releases). O `SHA256SUMS` da release
   também lista o AppImage.
2. **Dê permissão de execução** e abra: `chmod +x DiscVoice_*.AppImage && ./DiscVoice_*.AppImage`.
   Funciona em distros com glibc 2.35 ou mais nova (Ubuntu 22.04, Fedora 36, Debian 12 em diante).
3. **Ícone na bandeja:** no GNOME, instale a extensão AppIndicator. Se a janela ficar em
   branco (comum com placas NVIDIA), abra com `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

Os pacotes também podem ser gerados localmente. No Windows:

```powershell
npm ci
npm run build:windows
```

O instalador fica em `target/release/bundle/nsis/`. No Linux, com as bibliotecas de sistema
instaladas (veja a [documentação](DOCS.md#executar-no-linux)):

```bash
npm ci
npm run build:appimage
```

O AppImage fica em `target/release/bundle/appimage/` (`npm run build:linux` gera `.deb` e
`.rpm`). Os requisitos completos de desenvolvimento estão na
[documentação](DOCS.md#executar-no-windows).

### Usar a versão web

Com Docker e Node.js instalados, na raiz do projeto:

```powershell
Copy-Item .env.example .env
npm ci
npm run services:up
```

Depois abra **<http://localhost:3001>**. No Linux, use `cp .env.example .env`.
A versão web compartilha a mesma API, contas, servidores e canais do aplicativo desktop.

---

## 🐞 Encontrou um bug?

Toda ajuda é bem-vinda! Antes de abrir uma issue:

- 🔍 Procure nas [issues existentes](https://github.com/gabrielmelogm/disc-voice/issues)
  para evitar relatos duplicados.
- ⬆️ Confirme se o problema acontece na versão mais recente (**0.1.0-alpha.2**).
- 🧪 Se possível, tente reproduzir o bug mais de uma vez.

### Como abrir uma issue

1. Acesse **[Nova issue](https://github.com/gabrielmelogm/disc-voice/issues/new)**.
2. Use um título claro e descritivo, como `[Bug] Microfone não aparece após conectar via USB`.
3. Descreva o que aconteceu com o máximo de detalhes: passos para reproduzir, comportamento
   esperado e comportamento atual.
4. Informe a **versão do Disc Voice** (`0.1.0-alpha.2`), o sistema (versão do Windows ou distro Linux e desktop), o modelo do
   microfone, da saída de áudio ou da webcam quando o problema for relacionado a dispositivos.
5. Anexe prints, vídeos ou logs que ajudem a entender o problema.
6. Clique em **Submit new issue** e acompanhe as respostas.

Você pode copiar este modelo para o corpo da issue:

```markdown
## Descrição do bug
Uma descrição curta e clara do que aconteceu.

## Como reproduzir
1. Abra o Disc Voice
2. Vá em '...'
3. Clique em '...'
4. Veja o erro

## Comportamento esperado
O que deveria ter acontecido.

## Comportamento atual
O que realmente aconteceu.

## Ambiente
- Versão do Disc Voice: 0.1.0-alpha.2
- Sistema: Windows 10/11 (build) ou Linux (distro, versão e desktop, ex.: Ubuntu 24.04 GNOME)
- Microfone/saída/webcam (se aplicável):
- Versão instalada ou versão web:

## Evidências
Prints, vídeos ou logs relevantes.
```

> [!WARNING]
> Nunca inclua **senhas**, **tokens de sessão**, **códigos de convite** ou outros dados
> pessoais na issue. Essas informações são sensíveis.

Sugestões e ideias de novas funcionalidades também são bem-vindas na
[página de issues](https://github.com/gabrielmelogm/disc-voice/issues).

---

## 📚 Documentação

| Documento | Conteúdo |
|:--|:--|
| 📖 [DOCS.md](DOCS.md) | Guia completo de contas, servidores, canais, convites e banco de dados |
| 🎙️ [Testes de dispositivos](DOCS.md#testes-de-dispositivos) | Microfone, saída de áudio e webcam na prática |
| 🪟 [Executar no Windows](DOCS.md#executar-no-windows) | Requisitos, desenvolvimento e geração do instalador |
| 🐧 [WSL ou Linux](DOCS.md#desenvolvimento-no-wsl-ou-linux) | Como rodar a API e a versão web |
| 🧪 [Testes automatizados](DOCS.md#desenvolvimento-e-testes-automatizados) | Comandos de verificação e testes da API |
| 🏗️ [Estrutura](DOCS.md#estrutura) | Organização do monorepo, API, desktop e motor de áudio |

---

<p align="center">
  <img src="public/icon.png" alt="" width="40" />
  <br />
  <sub><strong>Disc Voice</strong> · versão 0.1.0-alpha.2 · feito com Tauri, React, Rust e TypeScript</sub><br />
  <sub>Projeto independente, sem vínculo com o Discord.</sub>
</p>
