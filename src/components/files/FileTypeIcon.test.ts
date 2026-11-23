import { describe, expect, it } from "vitest";
import { getFileIcon } from "react-material-icon-theme";
import { knownExtension } from "./FileTypeIcon";

// PRO-401: the pack matches an extension only when handed one, so every .tsx, .json and .md drew the same blank page.
const known = (ext: string) => getFileIcon({ fileExtension: ext }) !== "file";
const icon = (name: string) => getFileIcon({ fileName: name.toLowerCase(), fileExtension: knownExtension(name, known) });

describe("the extension a file's icon is found by", () => {
  it("is the longest one the pack knows, whatever the case", () => {
    expect(knownExtension("scripts.test.ts", known)).toBe("test.ts");
    expect(knownExtension("scripts.ts", known)).toBe("ts");
    expect(knownExtension("App.TSX", known)).toBe("tsx");
    expect(knownExtension("archive.tar.zqx", known)).toBeUndefined();
    expect(knownExtension("Makefile", known)).toBeUndefined();
  });

  it("gives the common types their own icons, and whole names theirs", () => {
    const icons = ["ProjectScripts.tsx", "scripts.ts", "notes.md", "data.json", "ci.yml", "tokens.css", "bun.lock", "Dockerfile", "main.rs"].map(icon);
    expect(icons).not.toContain("file");
    expect(new Set(icons).size).toBe(icons.length);
    expect(icon("package.json")).toBe("nodejs");
    expect(icon("no-such-type.zqx")).toBe("file");
  });
});
