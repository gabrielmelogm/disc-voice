import { describe, expect, it } from "vitest";
import { version } from "../../package.json";
import { CHANGELOG, releaseDate } from "./changelog";

describe("changelog", () => {
  it("has an entry for the version being released, at the top", () => {
    // A release bumps the version: add its "Novidades" entry in the same PR.
    expect(CHANGELOG[0].version).toBe(version);
  });

  it("lists each version once, newest first, with a valid date and some change", () => {
    expect(new Set(CHANGELOG.map(entry => entry.version)).size).toBe(CHANGELOG.length);
    for (const [i, entry] of CHANGELOG.entries()) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(entry.date))).toBe(false);
      if (i) expect(entry.date <= CHANGELOG[i - 1].date).toBe(true);
      expect([...entry.added ?? [], ...entry.improved ?? [], ...entry.fixed ?? []].length).toBeGreaterThan(0);
    }
  });

  it("writes dates in Portuguese", () => {
    expect(releaseDate("2026-11-27")).toBe("27 de novembro de 2026");
  });
});
