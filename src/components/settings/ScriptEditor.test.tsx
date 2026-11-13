import { expect, it } from "vitest";
import { shellTokens } from "./ScriptEditor";

const kinds = (line: string) => shellTokens(line).filter((token) => token.kind !== "plain").map((token) => [token.text, token.kind]);

it("colours the command, builtins, strings, variables and comments of each line", () => {
  expect(kinds('cp "$TERMINALX_REPO_ROOT/.env" .env')).toEqual([["cp", "command"], ['"$TERMINALX_REPO_ROOT/.env"', "string"]]);
  expect(kinds("set -euo pipefail")).toEqual([["set", "builtin"]]);
  expect(kinds("FOO=1 pnpm db:migrate && rm -rf .turbo # tidy")).toEqual([["pnpm", "command"], ["rm", "command"], ["# tidy", "comment"]]);
  expect(kinds("echo $HOME ${PORT:-3000}")).toEqual([["echo", "command"], ["$HOME", "variable"], ["${PORT:-3000}", "variable"]]);
  expect(kinds("#!/usr/bin/env bash")).toEqual([["#!/usr/bin/env bash", "comment"]]);
  expect(kinds("if true; then make; fi")).toEqual([["if", "builtin"], ["true", "command"], ["then", "builtin"], ["make", "command"], ["fi", "builtin"]]);
});

it("keeps every character, including an unterminated string", () => {
  for (const line of ["echo 'open", 'a "b\\"c" d', "x|y;z&", "  indented  "]) {
    expect(shellTokens(line).map((token) => token.text).join("")).toBe(line);
  }
});
