/** Emoji offered in the picker, with Portuguese words to search for them. */
export interface Emoji { emoji: string; words: string }
export interface EmojiCategory { id: string; label: string; icon: string; emojis: Emoji[] }

/** Each line: the emoji, then the words that find it. */
const DATA: [id: string, label: string, list: string][] = [
  ["smileys", "Carinhas", `
😀 sorriso feliz alegre
😃 sorriso feliz olhos
😄 sorriso feliz risada
😁 sorriso dentes
😆 risada rindo
😅 suor nervoso risada
🤣 rolando rindo gargalhada
😂 chorando de rir lágrimas risada kkk
🙂 sorriso leve
🙃 de cabeça para baixo ironia
😉 piscadela piscando
😊 sorriso corado fofo
😇 anjo inocente
🥰 apaixonado corações amor
😍 olhos de coração amor
🤩 estrelas deslumbrado
😘 beijo
😋 delicioso gostoso
😛 língua
😜 língua piscando brincadeira
🤪 maluco doido
🤑 dinheiro rico
🤗 abraço
🤭 ops mão na boca
🤫 silêncio segredo
🤔 pensando dúvida hmm
🤐 boca fechada zíper
🤨 sobrancelha desconfiado
😐 neutro sem expressão
😑 sem expressão
😶 sem boca mudo
😏 sorriso malicioso
😒 entediado insatisfeito
🙄 revirando os olhos
😬 careta constrangido
😌 aliviado tranquilo
😔 pensativo triste
😪 sono
🤤 babando
😴 dormindo zzz
😷 máscara doente
🤒 febre doente
🤕 machucado
🤢 enjoado náusea
🤮 vomitando
🥵 calor quente
🥶 frio congelando
🥴 tonto zonzo
😵 tonto
🤯 cabeça explodindo chocado
🤠 caubói
🥳 festa comemoração aniversário
😎 óculos escuros legal
🤓 nerd
🧐 monóculo analisando
😕 confuso
😟 preocupado
🙁 triste
😮 surpreso boca aberta uau
😯 surpreso
😲 espantado chocado
😳 envergonhado corado
🥺 pidão por favor olhos
😦 assustado
😧 angustiado
😨 com medo
😰 ansioso suor
😥 desapontado aliviado
😢 chorando triste lágrima
😭 chorando muito triste
😱 gritando medo
😖 frustrado
😣 perseverante
😞 decepcionado
😓 suor frio
😩 cansado exausto
😫 cansado
🥱 bocejo sono tédio
😤 bufando triunfo
😡 bravo raiva
😠 bravo irritado
🤬 xingando palavrão
😈 diabinho malvado
👿 diabo bravo
💀 caveira morri
👻 fantasma
👽 alienígena et
🤖 robô
💩 cocô
🤡 palhaço
🙈 macaco não vejo
🙉 macaco não ouço
🙊 macaco não falo`],
  ["people", "Gestos e pessoas", `
👍 joinha positivo curti ok sim
👎 negativo não
👌 ok perfeito
🤌 dedos juntos italiano
✌️ paz vitória
🤞 dedos cruzados sorte
🤟 te amo
🤘 rock
🤙 me liga
👈 apontando esquerda
👉 apontando direita
👆 apontando cima
👇 apontando baixo
☝️ indicador um
✋ mão parar
🖐️ mão aberta
👋 tchau oi aceno olá
👏 palmas aplausos
🙌 celebrando mãos para cima
🤝 aperto de mãos acordo
🙏 por favor obrigado reza
💪 forte músculo
✍️ escrevendo
🫶 coração com as mãos
🫡 continência sentido
🫠 derretendo
👀 olhos olhando vendo
👁️ olho
🧠 cérebro inteligente
🗣️ falando
👶 bebê
🧒 criança
👦 menino
👧 menina
🧑 pessoa
👨 homem
👩 mulher
🧓 idoso
🧑‍💻 programador computador dev
🧑‍🎨 artista
🧑‍🚀 astronauta
🧑‍🍳 cozinheiro chef
🤷 sei lá não sei
🤦 facepalm vergonha
🙋 levantando a mão eu
🙇 reverência desculpa
💃 dançando
🕺 dançando
🏃 correndo
🚶 andando`],
  ["nature", "Natureza", `
🐶 cachorro cão
🐱 gato
🐭 rato
🐹 hamster
🐰 coelho
🦊 raposa
🐻 urso
🐼 panda
🐨 coala
🐯 tigre
🦁 leão
🐮 vaca
🐷 porco
🐸 sapo
🐵 macaco
🐔 galinha
🐧 pinguim
🐦 pássaro
🦆 pato
🦉 coruja
🦇 morcego
🐺 lobo
🐴 cavalo
🦄 unicórnio
🐝 abelha
🐛 lagarta
🦋 borboleta
🐌 caracol
🐢 tartaruga
🐍 cobra
🐙 polvo
🦀 caranguejo
🐠 peixe
🐬 golfinho
🐳 baleia
🦈 tubarão
🐊 jacaré
🦖 dinossauro
🌵 cacto
🌲 árvore pinheiro
🌴 palmeira
🍀 trevo sorte
🌿 erva planta
🍁 folha outono
🌸 flor cerejeira
🌹 rosa flor
🌻 girassol
🌞 sol sorrindo
🌝 lua cheia
🌙 lua
⭐ estrela
🌟 estrela brilhante
✨ brilho brilhos
⚡ raio energia
🔥 fogo foguinho top
🌈 arco-íris
☀️ sol
⛅ nublado
🌧️ chuva
⛈️ tempestade
❄️ neve floco
☃️ boneco de neve
💧 gota água
🌊 onda mar`],
  ["food", "Comida", `
🍏 maçã verde
🍎 maçã
🍐 pera
🍊 laranja
🍋 limão
🍌 banana
🍉 melancia
🍇 uva
🍓 morango
🍒 cereja
🍑 pêssego
🥭 manga
🍍 abacaxi
🥥 coco
🥝 kiwi
🍅 tomate
🥑 abacate
🌽 milho
🥕 cenoura
🥔 batata
🌶️ pimenta
🥦 brócolis
🍞 pão
🧀 queijo
🥚 ovo
🍳 ovo frito
🥓 bacon
🍔 hambúrguer lanche
🍟 batata frita
🍕 pizza
🌭 cachorro-quente
🌮 taco
🌯 burrito
🍝 macarrão
🍜 lámen
🍣 sushi
🍚 arroz
🍿 pipoca
🍩 rosquinha donut
🍪 biscoito cookie
🎂 bolo aniversário
🍰 bolo fatia
🧁 cupcake
🍫 chocolate
🍬 bala doce
🍭 pirulito
🍦 sorvete
☕ café
🍵 chá
🧉 chimarrão mate
🥤 refrigerante
🧃 suco
🍺 cerveja
🍻 brinde cerveja
🥂 brinde taças
🍷 vinho
🍸 drinque
🥃 uísque`],
  ["activities", "Atividades", `
⚽ futebol bola
🏀 basquete
🏈 futebol americano
⚾ beisebol
🎾 tênis
🏐 vôlei
🏓 pingue-pongue
🎱 sinuca
🏆 troféu campeão
🥇 medalha ouro primeiro
🥈 medalha prata segundo
🥉 medalha bronze terceiro
🏅 medalha
🎮 videogame jogo controle
🕹️ joystick
🎲 dado
🧩 quebra-cabeça
♟️ xadrez
🎯 alvo
🎳 boliche
🎸 guitarra
🎹 teclado piano
🥁 bateria
🎤 microfone karaokê
🎧 fone música
🎬 claquete filme
🎨 paleta arte
🎭 teatro
🎉 festa confete parabéns
🎊 confete
🎈 balão
🎁 presente
🎄 natal árvore
🎃 abóbora halloween
🎆 fogos de artifício`],
  ["travel", "Viagens e lugares", `
🚗 carro
🚕 táxi
🚌 ônibus
🚓 polícia
🚑 ambulância
🚒 bombeiros
🏎️ carro de corrida
🏍️ moto
🚲 bicicleta
🛴 patinete
🚀 foguete lançamento
✈️ avião viagem
🚁 helicóptero
⛵ barco veleiro
🚢 navio
🚂 trem
🗺️ mapa
🧭 bússola
🏠 casa
🏢 prédio escritório
🏫 escola
🏥 hospital
🏖️ praia
🏝️ ilha
⛰️ montanha
🌋 vulcão
🏕️ acampamento
🗽 estátua da liberdade
🗼 torre
🎡 roda-gigante
🌃 noite cidade
🌅 nascer do sol`],
  ["objects", "Objetos", `
💻 notebook computador
🖥️ computador monitor
⌨️ teclado
🖱️ mouse
📱 celular
☎️ telefone
📷 câmera foto
🎥 câmera filme
📺 tv televisão
🔊 som alto
🔇 mudo
🔔 sino notificação
📢 megafone anúncio
💡 lâmpada ideia
🔦 lanterna
📚 livros estudar
📖 livro
📝 anotação memo
✏️ lápis
🖊️ caneta
📌 alfinete fixado pin
📎 clipe
📁 pasta
📅 calendário
📈 gráfico subindo
📉 gráfico caindo
📊 gráfico barras
🔒 cadeado trancado
🔓 destrancado
🔑 chave
🔨 martelo
🛠️ ferramentas
⚙️ engrenagem configurações
🧪 tubo de ensaio teste
🔬 microscópio
💊 remédio
💰 dinheiro saco
💸 dinheiro voando
💳 cartão
⏰ despertador
⌛ ampulheta
🕐 relógio
📦 caixa pacote
✉️ envelope e-mail
🗑️ lixeira
🧹 vassoura
🛒 carrinho compras`],
  ["symbols", "Símbolos", `
❤️ coração amor vermelho
🧡 coração laranja
💛 coração amarelo
💚 coração verde
💙 coração azul
💜 coração roxo
🖤 coração preto
🤍 coração branco
🤎 coração marrom
💔 coração partido
❤️‍🔥 coração em chamas
💕 dois corações
💖 coração brilhante
💯 cem pontos perfeito
💢 raiva
💥 explosão
💫 tonto estrela
💦 gotas suor
💤 sono zzz
💬 balão fala
💭 pensamento
✅ certo feito concluído
☑️ marcado
✔️ certo
❌ errado x não
❎ x
⚠️ atenção aviso
⛔ proibido
🚫 proibido
❓ pergunta interrogação
❗ exclamação
‼️ dupla exclamação
➕ mais
➖ menos
➡️ seta direita
⬅️ seta esquerda
⬆️ seta cima
⬇️ seta baixo
🔄 atualizar repetir
🆗 ok
🆕 novo
🆒 legal cool
🔴 círculo vermelho
🟢 círculo verde
🟡 círculo amarelo
🔵 círculo azul
🟣 círculo roxo
⚫ círculo preto
⚪ círculo branco
1️⃣ um 1
2️⃣ dois 2
3️⃣ três 3
#️⃣ hashtag
🏁 bandeira quadriculada
🚩 bandeira vermelha
🏳️‍🌈 bandeira arco-íris
🇧🇷 brasil bandeira
🇵🇹 portugal bandeira`],
];

export const EMOJI_CATEGORIES: EmojiCategory[] = DATA.map(([id, label, list]) => {
  const emojis = list.trim().split("\n").map(line => {
    const space = line.indexOf(" ");
    return { emoji: line.slice(0, space), words: line.slice(space + 1) };
  });
  return { id, label, icon: emojis[0].emoji, emojis };
});

const ALL = EMOJI_CATEGORIES.flatMap(category => category.emojis);

function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Emoji whose words start with every word of the query. */
export function searchEmoji(query: string, limit = 64): Emoji[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return ALL.filter(item => {
    const words = fold(item.words).split(/[\s-]+/);
    return terms.every(term => words.some(word => word.startsWith(term)));
  }).slice(0, limit);
}

const RECENT_KEY = "discvoice.recentEmoji";

/** Emoji the user picked lately, newest first (empty when storage is unavailable). */
export function recentEmoji(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string").slice(0, 16) : [];
  } catch { return []; }
}

export function rememberEmoji(emoji: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter(e => e !== emoji)].slice(0, 16))); }
  catch { /* storage unavailable */ }
}

/** Offered first in a message's actions. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉"];
