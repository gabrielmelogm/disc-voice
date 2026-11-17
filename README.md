# Disc Voice

Aplicativo **Windows 10/11** com Tauri 2, React, TypeScript e Rust para testar microfones, saídas de áudio e webcams. Interface em português, sem servidor.

## Executar no Windows

Instale:

- **Node.js 22.12+** (recomendado: 24 LTS), com npm.
- **Rust stable**, toolchain `x86_64-pc-windows-msvc`, via [rustup](https://rustup.rs/).
- **Visual Studio Build Tools 2022**, com “Desenvolvimento para desktop com C++” e Windows SDK.
- **Microsoft Edge WebView2 Runtime** (já incluído na maioria das instalações do Windows 10/11).

Na raiz do projeto, em PowerShell:

```powershell
npm ci
npm run dev
```

Para gerar o instalador NSIS:

```powershell
npm run build:windows
```

O `.exe` fica em `target/release/bundle/nsis/`. O instalador baixa o WebView2 caso necessário, portanto essa etapa precisa de internet se o runtime estiver ausente.

## Testes de dispositivos

1. **Microfone:** selecione uma entrada e clique em **Testar microfone**. O medidor exibe o pico capturado e seu nível em dBFS. Fale por até 10 segundos; também é possível finalizar antes.
2. **Saída:** selecione a saída física, ajuste o volume do teste e clique em **Tocar som**. Um tom suave de 440 Hz toca por 3 segundos em todos os canais da saída. **Ouvir gravação** reproduz o último trecho capturado nesse mesmo dispositivo.
3. **Webcam:** selecione uma câmera e clique em **Testar webcam**. Aceite a permissão do WebView2. A prévia mostra resolução e taxa de quadros reportadas pela câmera, com opção de espelhamento.
4. **Atualizar dispositivos** refaz a enumeração. Eventos `devicechange` também atualizam as listas quando disponibilizados pelo WebView2. Desconexões durante a captura são tratadas.
5. **Encerrar todos os testes** libera os dispositivos. Fechar o app também encerra os streams.

A webcam não captura áudio. Antes da primeira permissão, o WebView2 pode ocultar nomes e câmeras; use a câmera padrão para autorizar e atualizar a lista. Se o acesso falhar, habilite câmera/microfone para **aplicativos da área de trabalho** em Configurações do Windows → Privacidade e segurança.

A gravação fica **somente na memória**, é substituída na próxima captura e descartada ao fechar o aplicativo. O volume controla apenas a reprodução do teste, sem alterar o volume do Windows. Captura de microfone e reprodução de áudio são mutuamente exclusivas para evitar gravar o próprio som de teste.

## Estrutura

```text
apps/
  desktop/
    src/                React, hooks de dispositivos e testes
    src-tauri/          Janela Tauri, comandos IPC, configuração Windows
    scripts/            Verificação da plataforma
packages/
  shared/               Contratos TypeScript de IPC
  audio-engine/         Motor Rust: WASAPI/CPAL, gravação e reprodução
.github/workflows/      Testes e build do instalador no Windows
```

- npm workspaces organizam os pacotes JavaScript; Cargo workspace organiza os crates Rust.
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

Os testes cobrem seleção e troca de dispositivos, comandos IPC, erros, liberação da webcam, cancelamento de permissões pendentes, estados de captura, limite da gravação, reamostragem e geração do tom. Hardware real não é necessário para esses testes.

O workflow `Windows` executa as verificações, compila o aplicativo e publica o instalador como artefato de CI.

### Prévia da interface

```sh
npm run dev:web
```

Abra `http://127.0.0.1:1420`. Essa prévia também funciona no Linux, mas o **áudio nativo só funciona no aplicativo Windows**. As listas de áudio não são simuladas. A webcam da prévia depende das permissões do navegador.

### Validação manual no Windows

- Testar entrada e saída integradas e USB, incluindo dois dispositivos com nomes iguais.
- Ouvir o tom e a gravação em uma saída diferente da saída padrão do Windows.
- Desconectar um dispositivo durante o teste e atualizar a lista.
- Negar a permissão da webcam, tentar novamente, cancelar enquanto a permissão está pendente e trocar de câmera.
- Confirmar que o indicador da webcam apaga ao parar ou fechar o app.
- Instalar o `.exe` e repetir os testes na versão empacotada, além de `npm run dev`.

Os testes automatizados não substituem essa verificação com drivers e hardware reais.
