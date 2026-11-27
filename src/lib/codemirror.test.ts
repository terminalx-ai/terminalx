import { describe, expect, it } from "vitest";
import { languageFor, loadLanguageFor } from "./codemirror";

describe("P-10 lazy CodeMirror language packs", () => {
  it("loads extensions dynamically on demand and caches them for synchronous lookup", async () => {
    const unknown = await loadLanguageFor("notes.unknownext");
    expect(unknown).toEqual([]);
    expect(languageFor("notes.unknownext")).toEqual([]);

    const ts = await loadLanguageFor("src/app.ts");
    expect(ts).toBeTruthy();
    expect(Array.isArray(ts)).toBe(false);
    // Once loaded, synchronous languageFor returns the cached extension immediately.
    expect(languageFor("other.ts")).toBe(ts);

    const [tsx, rust, py, json, md, css, html] = await Promise.all([
      loadLanguageFor("App.tsx"),
      loadLanguageFor("lib.rs"),
      loadLanguageFor("script.py"),
      loadLanguageFor("config.json"),
      loadLanguageFor("README.md"),
      loadLanguageFor("theme.css"),
      loadLanguageFor("index.html"),
    ]);
    for (const ext of [tsx, rust, py, json, md, css, html]) {
      expect(ext).toBeTruthy();
      expect(Array.isArray(ext)).toBe(false);
    }
  });
});
