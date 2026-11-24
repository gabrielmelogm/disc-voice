import { beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./theme");
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("custom themes", () => {
  it("keeps the built-in themes readable without adjustments", async () => {
    const { resolveTheme } = await load();
    expect(resolveTheme("light", {}).adjusted).toEqual([]);
    expect(resolveTheme("dark", {}).adjusted).toEqual([]);
  });

  it("parses a theme, falling back to the base for missing colors", async () => {
    const { parseTheme, resolveTheme, THEME_EXAMPLE, BASE_THEMES } = await load();
    const theme = parseTheme(JSON.stringify(THEME_EXAMPLE));
    expect(theme).toMatchObject({ name: "Aurora", author: "Gabi Nunes", base: "dark" });
    expect(theme.colors.brand).toBe("#1fb5a3");
    const resolved = resolveTheme(theme.base, theme.colors).colors;
    expect(resolved["danger"]).toBe(BASE_THEMES.dark.danger);
  });

  it("builds a template with every color that imports as is", async () => {
    const { parseTheme, themeTemplate, THEME_TOKENS, BASE_THEMES } = await load();
    for (const base of ["light", "dark"] as const) {
      const template = themeTemplate(base);
      expect(Object.keys(template.colors)).toEqual(THEME_TOKENS);
      expect(template.colors).toEqual(BASE_THEMES[base]);
      const theme = parseTheme(JSON.stringify(template));
      expect(theme).toMatchObject({ base, adjusted: [] });
      expect(Object.keys(theme.colors)).toHaveLength(THEME_TOKENS.length);
    }
  });

  it("rejects invalid files with a clear message", async () => {
    const { parseTheme } = await load();
    const valid = { name: "Tema", base: "light", colors: {} };
    expect(() => parseTheme("{")).toThrow("JSON válido");
    expect(() => parseTheme("[]")).toThrow("objeto JSON");
    expect(() => parseTheme(JSON.stringify({ ...valid, extra: 1 }))).toThrow("Campo desconhecido no tema: extra");
    expect(() => parseTheme(JSON.stringify({ ...valid, name: " " }))).toThrow('"name"');
    expect(() => parseTheme(JSON.stringify({ ...valid, base: "sepia" }))).toThrow('"base"');
    expect(() => parseTheme(JSON.stringify({ ...valid, colors: { primary: "#fff" } }))).toThrow('Cor desconhecida: "primary"');
    expect(() => parseTheme(JSON.stringify({ ...valid, colors: { ink: "red" } }))).toThrow('"ink" deve estar no formato');
    expect(() => parseTheme(JSON.stringify({ ...valid, colors: { ink: "url(x)" } }))).toThrow();
    expect(() => parseTheme(" ".repeat(200 * 1024 + 1))).toThrow("200 KB");
  });

  it("adjusts text colors below 4.5:1 and reports them", async () => {
    const { contrast, parseTheme, resolveTheme } = await load();
    const theme = parseTheme(JSON.stringify({ name: "Baixo contraste", base: "light", colors: { surface: "#ffffff", ink: "#dddddd", "on-brand": "#7010d0" } }));
    expect(theme.adjusted).toEqual(expect.arrayContaining(["ink", "on-brand"]));
    const colors = resolveTheme(theme.base, theme.colors).colors;
    for (const bg of ["surface", "surface-sunken", "fill"] as const) expect(contrast(colors.ink, colors[bg])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors["on-brand"], colors.brand)).toBeGreaterThanOrEqual(4.5);
  });

  it("applies, persists and removes imported themes", async () => {
    let theme = await load();
    const stored = theme.addTheme(theme.parseTheme(JSON.stringify(theme.THEME_EXAMPLE)));
    theme.setAppearance(`theme:${stored.id}`);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#1fb5a3");

    // A restart reads the same theme back.
    theme = await load();
    theme.applyAppearance();
    expect(theme.useThemes).toBeTypeOf("function");
    expect(document.documentElement.style.getPropertyValue("--surface")).toBe("#0f1d24");
    // Importing the same theme again replaces it.
    theme.addTheme(theme.parseTheme(JSON.stringify(theme.THEME_EXAMPLE)));
    expect(JSON.parse(localStorage.getItem("discvoice.themes")!)).toHaveLength(1);

    theme.removeTheme(stored.id);
    expect(localStorage.getItem("discvoice.appearance")).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("");
  });

  it("ignores tampered stored themes", async () => {
    localStorage.setItem("discvoice.themes", JSON.stringify([{ id: "x", name: "Mau", base: "light", colors: { ink: "expression(alert(1))" } }]));
    localStorage.setItem("discvoice.appearance", "theme:x");
    const theme = await load();
    theme.applyAppearance();
    expect(document.documentElement.style.getPropertyValue("--ink")).toBe("");
    expect(localStorage.getItem("discvoice.appearance")).toBe("theme:x");
  });
});
