import type { User } from "@disc-voice/shared";

/** A mention as stored in a message: `<@user-id>`. */
export const MENTION = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** Mentions every member of the server; only the owner and moderators may use it. */
export const EVERYONE = "<@everyone>";
export const EVERYONE_NAME = "everyone";

/** Whether the message mentions everyone of the server. */
export function mentionsEveryone(content: string) {
  return content.includes(EVERYONE);
}

/** Text for previews and notifications: `<@id>` becomes `@Name`. */
export function mentionText(content: string, people: Pick<User, "id" | "name">[] = []) {
  return content
    .replace(MENTION, (_, id: string) => `@${people.find(p => p.id === id.toLowerCase())?.name || "alguém"}`)
    .replaceAll(EVERYONE, `@${EVERYONE_NAME}`);
}

function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Text typed in the composer, ready to send: `@Name` of these people becomes
 * `<@id>`. Longer names win ("@Ana Souza" over "@Ana"), and a name must end
 * there ("@Anabela" is not "@Ana"). With `everyone`, `@everyone` becomes
 * `<@everyone>`.
 */
export function encodeMentions(text: string, people: Pick<User, "id" | "name">[], everyone = false) {
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  let out = "";
  for (let index = 0; index < text.length;) {
    const startsWord = index === 0 || /\s|[([{"'“]/.test(text[index - 1]);
    if (text[index] === "@" && startsWord) {
      const rest = text.slice(index + 1);
      if (everyone && rest.startsWith(EVERYONE_NAME) && !/^[\p{L}\p{N}_]/u.test(rest.slice(EVERYONE_NAME.length))) {
        out += EVERYONE;
        index += 1 + EVERYONE_NAME.length;
        continue;
      }
      const person = sorted.find(p => rest.startsWith(p.name) && !/^[\p{L}\p{N}_]/u.test(rest.slice(p.name.length)));
      if (person) {
        out += `<@${person.id}>`;
        index += 1 + person.name.length;
        continue;
      }
    }
    out += text[index];
    index++;
  }
  return out;
}

/** The `@query` being typed before the caret, or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s|[([{"'“]/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > 32 || /\n/.test(query) || /^\s/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

/** Whether `@everyone` (or "todos") fits what is being typed. */
export function everyoneMatches(query: string) {
  const q = fold(query);
  return EVERYONE_NAME.startsWith(q) || "todos".startsWith(q);
}

/** People whose name (or a word of it) starts with the query, accents aside. */
export function mentionMatches<T extends Pick<User, "name">>(people: T[], query: string, limit = 8) {
  const q = fold(query);
  return people
    .map(person => {
      const name = fold(person.name);
      const rank = name.startsWith(q) ? 0 : name.split(/\s+/).some(word => word.startsWith(q)) ? 1 : -1;
      return { person, rank };
    })
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.person.name.localeCompare(b.person.name, "pt-BR"))
    .slice(0, limit)
    .map(item => item.person);
}
