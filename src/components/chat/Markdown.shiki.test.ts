import { describe, expect, it } from "vitest";
import { codePlugin } from "./Markdown";

describe("P-10 restricted Shiki language bundle", () => {
  it("keeps common developer languages and excludes obscure grammars", () => {
    const supported = new Set(codePlugin.getSupportedLanguages());
    for (const lang of ["typescript", "tsx", "javascript", "rust", "python", "go", "json", "yaml", "bash", "sh", "sql", "diff", "markdown"]) {
      expect(codePlugin.supportsLanguage(lang as never)).toBe(true);
    }
    for (const excluded of ["emacs-lisp", "wolfram", "abap", "cobol", "vue-vine", "angular-ts"]) {
      expect(supported.has(excluded as never)).toBe(false);
      expect(codePlugin.supportsLanguage(excluded as never)).toBe(false);
    }
    expect(codePlugin.getThemes()).toEqual(["github-light", "github-dark"]);
  });
});
