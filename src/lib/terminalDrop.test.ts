import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cmdQuotePath, droppedPathsText, droppedText, powershellQuotePath, shellQuotePath, unquotableMessage } from "./terminalDrop";

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
    expect(droppedPathsText(["/tmp/a.png", "/tmp/b c.png"], "posix")).toBe("/tmp/a.png /tmp/b\\ c.png ");
    expect(droppedPathsText([])).toBe("");
  });

  // On Windows `bash` on PATH is the WSL launcher, which rewrites backslashes
  // in its arguments before any shell reads them: no POSIX shell to ask.
  const installed = (shell: string) => {
    if (process.platform === "win32") return false;
    try {
      execFileSync(shell, ["-c", "true"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it.each(["bash", "zsh"])("is read back by %s as the same path, and runs nothing", (shell) => {
    if (!installed(shell)) return;
    const paths =["/tmp/plain.txt", "/tmp/my shot's \"x\" $HOME `id` $(id).png", "/tmp/a\nb\tc;rm -rf ~&|<>*?[]{}!#\\.txt", "/tmp/日本語 é.png", "-rf", "~/x", "/tmp/c1\u009b31m.txt"];
    const out = execFileSync(shell, ["-c", `printf '%s\\0' ${droppedPathsText(paths, "posix")}`], { encoding: "utf8" });
    expect(out.split("\0").slice(0, -1)).toEqual(paths);
  });
});

describe("quoting a dropped path for cmd", () => {
  it("double-quotes what cmd would act on, and refuses what it would expand", () => {
    expect(cmdQuotePath("C:\\a & b | c < d > e ^ f.png")).toBe('"C:\\a & b | c < d > e ^ f.png"');
    expect(cmdQuotePath("C:\\100%.png")).toBeNull();
    expect(cmdQuotePath("C:\\a\nb.png")).toBeNull();
    expect(cmdQuotePath("")).toBeNull();
    expect(droppedPathsText(["C:\\a.png", "C:\\%PATH%.png"], "cmd")).toBeNull();
    expect(droppedPathsText(["C:\\a.png", "C:\\b c.png"], "cmd")).toBe('"C:\\a.png" "C:\\b c.png" ');
  });

  it("is read back by cmd as the same word, and runs nothing", () => {
    if (process.platform !== "win32") return;
    for (const path of ["C:\\a & echo INJECTED.txt", "C:\\b | echo INJECTED.txt", "C:\\c ^ d > e < f.txt"]) {
      const quoted = cmdQuotePath(path)!;
      const out = spawnSync("cmd.exe", ["/d", "/s", "/c", `"echo ${quoted}"`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout;
      expect(out.trim()).toBe(quoted);
      expect(out).not.toMatch(/^INJECTED/m);
    }
  });
});

describe("quoting a dropped path for PowerShell", () => {
  it("single-quotes every path and doubles each kind of single quote", () => {
    expect(powershellQuotePath("C:\\Users\\me\\a b.png")).toBe("'C:\\Users\\me\\a b.png'");
    expect(powershellQuotePath("C:\\it's \u2018x\u2019.png")).toBe("'C:\\it''s \u2018\u2018x\u2019\u2019.png'");
    expect(droppedPathsText(["C:\\a.png", "C:\\b c.png"], "powershell")).toBe("'C:\\a.png' 'C:\\b c.png' ");
  });

  it("refuses a path holding a control character, which would reach the terminal as a key", () => {
    expect(powershellQuotePath("C:\\a\nb.png")).toBeNull();
    expect(powershellQuotePath("C:\\a\u007fb.png")).toBeNull();
    expect(powershellQuotePath("C:\\a\u009bb.png")).toBeNull();
    expect(powershellQuotePath("")).toBeNull();
    expect(droppedPathsText(["C:\\ok.png", "C:\\a\u0085b.png"], "powershell")).toBeNull();
    expect(unquotableMessage("powershell")).toMatch(/control character/);
    expect(unquotableMessage("cmd")).toMatch(/%/);
  });

  it("is read back by PowerShell as the same path, and runs nothing", () => {
    if (process.platform !== "win32") return;
    const paths = ["C:\\plain.txt", "C:\\my shot's $HOME `id` $(calc) ;whoami & x.png", "C:\\it\u2019s \u201aq\u201b.txt", "-rf", "~\\x", "C:\\日本語 é.png"];
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & { foreach ($a in $args) { [Console]::Out.Write($a + [char]0) } } ${droppedPathsText(paths, "powershell")}`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
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
