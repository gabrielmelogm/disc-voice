/** Initials of the first and last words of a name ("Clube do Livro" → "CL", "Levi" → "L"). */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picked.map(word => Array.from(word)[0]).join("").toLocaleUpperCase("pt-BR") || "?";
}

/** Hides most of the local part of an e-mail address ("levi@x.com" → "l•••@x.com"). */
export function maskEmail(email: string) {
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  return `${Array.from(email)[0]}••••${email.slice(at)}`;
}

export function messageTime(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return `Hoje às ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Ontem às ${time}`;
  return `${date.toLocaleDateString("pt-BR")} às ${time}`;
}

export function dayLabel(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return "Hoje";
  if (date.toDateString() === yesterday.toDateString()) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
}
