import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { droppedPathsText, shellQuotePath } from "./terminalDrop";

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

  it("types several paths separated by spaces, with no Enter", () => {
    expect(droppedPathsText(["/tmp/a.png", "/tmp/b c.png"])).toBe("/tmp/a.png /tmp/b\\ c.png ");
    expect(droppedPathsText([])).toBe("");
  });

  it.each(["bash", "zsh"])("is read back by %s as the same path, and runs nothing", (shell) => {
    const paths = ["/tmp/plain.txt", "/tmp/my shot's \"x\" $HOME `id` $(id).png", "/tmp/a\nb\tc;rm -rf ~&|<>*?[]{}!#\\.txt", "/tmp/日本語 é.png", "-rf", "~/x"];
    const out = execFileSync(shell, ["-c", `printf '%s\\0' ${droppedPathsText(paths)}`], { encoding: "utf8" });
    expect(out.split("\0").slice(0, -1)).toEqual(paths);
  });
});
