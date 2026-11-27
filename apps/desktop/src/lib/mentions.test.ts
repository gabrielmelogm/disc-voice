import { describe, expect, it } from "vitest";
import { encodeMentions, mentionMatches, mentionQuery, mentionText } from "./mentions";

const ana = { id: "00000000-0000-4000-8000-000000000001", name: "Ana" };
const anaSouza = { id: "00000000-0000-4000-8000-000000000002", name: "Ana Souza" };
const levi = { id: "00000000-0000-4000-8000-000000000003", name: "Levi" };

describe("mentions", () => {
  it("encodes typed names, preferring the longest and whole names", () => {
    expect(encodeMentions("@Ana Souza e @Ana, cadê @Anabela? e-mail@Levi", [ana, anaSouza, levi]))
      .toBe(`<@${anaSouza.id}> e <@${ana.id}>, cadê @Anabela? e-mail@Levi`);
    expect(encodeMentions("(@Levi)", [levi])).toBe(`(<@${levi.id}>)`);
  });

  it("shows stored mentions as names", () => {
    expect(mentionText(`<@${levi.id}> e <@00000000-0000-4000-8000-0000000000ff>`, [levi])).toBe("@Levi e @alguém");
    expect(mentionText(encodeMentions("oi @Ana Souza", [anaSouza]), [anaSouza])).toBe("oi @Ana Souza");
  });

  it("finds the query being typed", () => {
    expect(mentionQuery("oi @an", 6)).toEqual({ start: 3, query: "an" });
    expect(mentionQuery("@Ana So", 7)).toEqual({ start: 0, query: "Ana So" });
    expect(mentionQuery("e-mail@x", 8)).toBeNull();
    expect(mentionQuery("@ ana", 5)).toBeNull();
    expect(mentionQuery("oi", 2)).toBeNull();
  });

  it("matches names and words, ignoring accents", () => {
    const people = [{ name: "Álvaro" }, { name: "Ana Souza" }, { name: "Bruna Alves" }];
    expect(mentionMatches(people, "al").map(p => p.name)).toEqual(["Álvaro", "Bruna Alves"]);
    expect(mentionMatches(people, "").length).toBe(3);
  });
});
