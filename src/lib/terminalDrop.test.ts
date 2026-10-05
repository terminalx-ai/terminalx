import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { droppedPathsText, droppedText, shellQuotePath } from "./terminalDrop";

describe("quoting a dropped path", () => {
  it("leaves a plain path as it is", () => {
    expect(shellQuotePath("/Users/me/code/app-1/src/main_v2.rs")).toBe("/Users/me/code/app-1/src/main_v2.rs");
    expect(shellQuotePath("/tmp/café/日本語.png")).toBe("/tmp/café/日本語.png");
  });

  it("escapes what a shell would act on", () => {
    expect(shellQuotePath("/tmp/my file.png")).toBe("/tmp/my\\ file.png");
    expect(shellQuotePath(`/tmp/it's "q".png`)).toBe(`/tmp/it\\'s\\ \\"q\\".png`);
    expect(shellQuotePath("/tmp/$HOME `id` $(id).png")).toBe("/tmp/\\$HOME\\ \\`id\\`\\ \\$\\(id\\).png");
    expect(shellQuotePath("/tmp/a;b&c|d>e<f*g?h[i]{j}~k!l#m\\n")).toBe("/tmp/a\\;b\\&c\\|d\\>e\\<f\\*g\\?h\\[i\\]\\{j\\}\\~k\\!l\\#m\\\\n");
  });

  it("never emits a raw control character", () => {
    expect(shellQuotePath("/tmp/a\nb\rc\td\x1be\x7f")).toBe("/tmp/a$'\\n'b$'\\r'c$'\\t'd$'\\x1b'e$'\\x7f'");
  });

  it("escapes C1 controls too, as bytes every shell reads", () => {
    expect(shellQuotePath("/tmp/a\u0080b\u009bc")).toBe("/tmp/a$'\\xc2\\x80'b$'\\xc2\\x9b'c");
  });

  it("types several paths separated by spaces, with no Enter", () => {
    expect(droppedPathsText(["/tmp/a.png", "/tmp/b c.png"])).toBe("/tmp/a.png /tmp/b\\ c.png ");
    expect(droppedPathsText([])).toBe("");
  });

  it.each(["bash", "zsh"])("is read back by %s as the same path, and runs nothing", (shell) => {
    const paths = ["/tmp/plain.txt", "/tmp/my shot's \"x\" $HOME `id` $(id).png", "/tmp/a\nb\tc;rm -rf ~&|<>*?[]{}!#\\.txt", "/tmp/日本語 é.png", "-rf", "~/x", "/tmp/c1\u009b31m.txt"];
    const out = execFileSync(shell, ["-c", `printf '%s\\0' ${droppedPathsText(paths)}`], { encoding: "utf8" });
    expect(out.split("\0").slice(0, -1)).toEqual(paths);
  });
});

describe("dragged text", () => {
  it("loses every control character, so it cannot end a bracketed paste or press a key", () => {
    expect(droppedText("ls\x1b[201~\rrm -rf x", true)).toBe("ls[201~\nrm -rf x");
    expect(droppedText("a\x00b\x07c\x08d\x7fe\u009b201~f\u0085g", true)).toBe("abcde201~fg");
  });

  it("keeps lines and tabs inside a bracketed paste, without the trailing newlines", () => {
    expect(droppedText("one\r\n\ttwo\rthree\n\n", true)).toBe("one\n\ttwo\nthree");
  });

  it("loses invisible and direction-changing characters", () => {
    expect(droppedText("a\u202eb\u2066c\u2069d\u200be\u200ff\ufeffg\u2028h\u2029i\u202aj", true)).toBe("abcdefghij");
  });

  it("trims long runs of newlines in time that grows with the text, not its square", () => {
    const run = "\n".repeat(200_000);
    const started = performance.now();
    expect(droppedText(`a${run}b${run}c${run}`, true)).toBe(`a${run}b${run}c`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("never sends a newline when the program has no bracketed paste", () => {
    expect(droppedText("echo one\nrm -rf x\r\n\tlast\n", false)).toBe("echo one rm -rf x last");
    expect(droppedText("ls\x1b[201~\rwhoami", false)).not.toMatch(/[\r\n\x1b]/);
  });
});
