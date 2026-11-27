/**
 * What changed in each release, written for the people who use the app (not
 * for developers): simple Portuguese, focused on what they can do now, with no
 * technical terms. Shown in Configurações → Novidades.
 *
 * Every release adds its entry at the top, with the same version as the
 * package.json (a test checks it) and the release date (YYYY-MM-DD).
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  /** Things the user can do now. */
  added?: string[];
  /** Things that got better. */
  improved?: string[];
  /** Problems that were solved. */
  fixed?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.1.0-alpha.3",
    date: "2026-11-27",
    added: [
      "No Linux, agora dá para baixar o Disc Voice direto pelo site, em três formatos: um arquivo que funciona em qualquer distribuição (AppImage), um para Ubuntu, Debian, Mint e Pop!_OS (.deb) e um para Fedora e openSUSE (.rpm).",
    ],
    improved: [
      "Os pacotes .deb e .rpm já instalam tudo o que a chamada de voz e o compartilhamento de tela precisam para funcionar.",
    ],
  },
  {
    version: "0.1.0-alpha.2",
    date: "2026-11-27",
    added: [
      "O Disc Voice chegou ao Linux: baixe um único arquivo, permita que ele seja executado e abra.",
      "Agora você pode reagir às mensagens com emojis.",
      "Mencione alguém com @ para chamar a atenção da pessoa na conversa.",
      "Escolha emojis num seletor, sem precisar decorar nenhum código.",
      "Compartilhe a tela junto com o som do computador e escolha a qualidade da transmissão.",
      "Assista a uma tela compartilhada numa janelinha flutuante enquanto usa outros programas.",
      "No Linux, o Disc Voice também pode ficar aberto em segundo plano, com um ícone perto do relógio.",
    ],
    improved: [
      "Vários ajustes no visual do app.",
    ],
  },
  {
    version: "0.1.0-alpha.1",
    date: "2026-11-26",
    added: [
      "Entre com a sua conta do Google ou do Discord.",
      "Converse em particular com seus amigos e adicione novos amigos.",
      "Veja quem está digitando e quantas mensagens você ainda não leu em cada conversa.",
      "Veja os membros de cada servidor, quem está online e o cargo de cada um.",
      "Envie arquivos e GIFs nas conversas.",
      "Converse por voz nos canais de voz, ligue a câmera, compartilhe a tela e organize os quadros da chamada do seu jeito.",
      "Troque mensagens de texto dentro da sala de voz, sem sair da chamada.",
      "Personalize seu perfil com nome, pronomes, “Sobre mim”, cor do banner e um GIF no avatar ou no banner.",
      "Crie seus próprios temas de cores ou use temas feitos por outras pessoas.",
      "Encontre qualquer opção das configurações pela busca.",
      "Receba avisos de novas mensagens e de quem entra na sala de voz, com sons durante a chamada.",
      "Vincule sua conta do Discord para mostrar o que você está jogando ou ouvindo, trazer seus servidores de lá e mostrar no Discord quando você estiver numa sala de voz.",
      "No Windows, deixe o Disc Voice aberto em segundo plano, com um ícone perto do relógio.",
      "Baixe o instalador para Windows direto pelo site.",
    ],
    improved: [
      "O app ganhou um visual novo, com uma barra de título própria no Windows.",
    ],
    fixed: [
      "Você continua conectado depois de fechar o app.",
      "Arrastar arquivos para a conversa voltou a funcionar no app.",
      "O modelo de tema baixado pelo app agora traz todas as cores.",
    ],
  },
  {
    version: "0.1.0-alpha",
    date: "2026-11-17",
    added: [
      "Crie sua conta no Disc Voice.",
      "Crie servidores e canais para conversar com seus amigos.",
    ],
  },
];

/** "27 de novembro de 2026". */
export function releaseDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
}
