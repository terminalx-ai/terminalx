import { describe, expect, it } from "vitest";
import { environmentNameError, parseLocalEnv } from "./localEnvironment";

describe("local environment paste", () => {
  it("imports ten lines including secrets and equals signs literally", () => {
    const text = Array.from({ length: 10 }, (_, i) => `API_KEY_${i}=secret=${i}`).join("\n");
    const parsed = parseLocalEnv(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.inputs).toHaveLength(10);
    expect(parsed.inputs[9]).toEqual({ name: "API_KEY_9", value: "secret=9" });
  });
  it("reports every invalid line without echoing values and keeps valid lines", () => {
    const { inputs, errors } = parseLocalEnv("# comment\nGOOD=one\nbad=sensitive\nGOOD=duplicate\nTERMINALX_NEXT_TOKEN=secret\nEMPTY=\nEXISTING=value\nNO_EQUALS", ["EXISTING"]);
    expect(inputs).toEqual([{ name: "GOOD", value: "one" }, { name: "EMPTY", value: "" }]);
    expect(errors.map((e) => e.match(/^Line \d+:/)?.[0])).toEqual(["Line 3:", "Line 4:", "Line 5:", "Line 7:", "Line 8:"]);
    expect(errors.join(" ")).not.toMatch(/sensitive|duplicate|secret=value/);
  });
  it("accepts comments, export, CRLF, quoted whitespace and literal substitutions", () => {
    expect(parseLocalEnv("export A=' a b ' # note\r\nB=\"$HOME\"\nC=$(touch something)\nD=hello # comment\nE=url#fragment")).toEqual({ inputs: [
      { name: "A", value: " a b " }, { name: "B", value: "$HOME" }, { name: "C", value: "$(touch something)" }, { name: "D", value: "hello" }, { name: "E", value: "url#fragment" },
    ], errors: [] });
  });
  it("rejects unterminated quotes, NUL and reserved names", () => {
    expect(parseLocalEnv("A='oops\nB=bad\0value").errors).toHaveLength(2);
    for (const name of ["HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PATH", "RACCOON", "RACCOON_HOOK_TOKEN", "CODEX_HOME", "TERM", "CLAUDECODE", "lower", "1BAD"]) expect(environmentNameError(name)).toBeTruthy();
    for (const name of ["_KEY", "API_KEY", "PORT", "DATABASE_URL"]) expect(environmentNameError(name)).toBeNull();
  });
});
