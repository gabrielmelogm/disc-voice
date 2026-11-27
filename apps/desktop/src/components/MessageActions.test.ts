import { describe, expect, it } from "vitest";
import { applyReaction, reactionLabel } from "./MessageActions";

describe("reactions", () => {
  it("adds and removes the user's reaction before the API answers", () => {
    const start = [{ emoji: "🔥", count: 1, users: ["a"] }];
    const added = applyReaction(start, "🔥", "me", true);
    expect(added).toEqual([{ emoji: "🔥", count: 2, users: ["a", "me"] }]);
    expect(applyReaction(added, "🔥", "me", true)).toBe(added);
    expect(applyReaction(added, "🔥", "me", false)).toEqual(start);
    expect(applyReaction(start, "🔥", "a", false)).toEqual([]);
    expect(applyReaction(undefined, "👀", "me", true)).toEqual([{ emoji: "👀", count: 1, users: ["me"] }]);
  });

  it("names who reacted", () => {
    const names = { a: "Ana", b: "Bruno", c: "Carla", d: "Diego" };
    expect(reactionLabel({ emoji: "👍", count: 1, users: ["me"] }, names, "me")).toBe("Você reagiu com 👍");
    expect(reactionLabel({ emoji: "👍", count: 2, users: ["a", "b"] }, names)).toBe("Ana e Bruno reagiram com 👍");
    expect(reactionLabel({ emoji: "👍", count: 5, users: ["a", "b", "c", "d", "x"] }, names)).toBe("Ana, Bruno, Carla e mais 2 reagiram com 👍");
  });
});
