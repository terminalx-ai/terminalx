import { describe, expect, it } from "vitest";
import { TERMINALX_VARIABLES, appliesTo, documentedVariables, environmentNameError, looksSecret, parseLocalEnv, withStorage, type EnvironmentRow } from "./localEnvironment";

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

describe("secret detection", () => {
  it("treats secret names, credential shapes and long random strings as secrets", () => {
    for (const [name, value] of [
      ["API_KEY", "x"], ["GH_TOKEN", "short"], ["STRIPE_SECRET_KEY", ""], ["DB_PASSWORD", "hunter2"], ["SENTRY_DSN", "https://abc@o1.ingest.sentry.io/1"],
      ["POSTHOG_KEY", "phc_8Qm2"], ["AWS_SECRET_ACCESS_KEY", "a"], ["GITHUBTOKEN", "a"], ["2FA_SEED", "JBSWY3DPEHPK3PXP"], ["MY_APIKEY", "a"],
      ["ANYTHING", "sk-ant-api03-abc"], ["ANYTHING", "ghp_abcdefghijklmnop"], ["ANYTHING", "AKIAIOSFODNN7EXAMPLE"], ["ANYTHING", "xoxb-1234-5678"],
      ["ANYTHING", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"], ["ANYTHING", "-----BEGIN OPENSSH PRIVATE KEY-----"],
      ["DATABASE_URL", "postgres://admin:s3cret@db.internal:5432/app"], ["RANDOM", "q8Zr2LkW9vXa7TnB4mYc1PdE6sHf"],
    ]) expect(looksSecret(name, value), `${name}=${value}`).toBe(true);
  });
  it("leaves ordinary configuration plain", () => {
    for (const [name, value] of [
      ["NODE_OPTIONS", "--max-old-space-size=8192"], ["PNPM_HOME", "/Users/me/Library/pnpm"], ["DATABASE_URL", "postgres://localhost:5432/dev"],
      ["VITE_RELAY_URL", "wss://relay.dev.terminalx.ai"], ["PORT", "3000"], ["KEYBOARD_LAYOUT", "us"], ["MONKEY", "banana"], ["AWS_REGION", "us-east-1"],
      ["EMPTY", ""], ["COMMIT", "0123456789abcdef0123456789abcdef01234567"], ["LOG_LEVEL", "debug"], ["GREETING", "hello world this is long text"],
    ]) expect(looksSecret(name, value), `${name}=${value}`).toBe(false);
  });
  it("stores everything plainly when the Keychain switch is off", () => {
    const inputs = [{ name: "API_KEY", value: "a" }, { name: "PORT", value: "3000" }];
    expect(withStorage(inputs, true).map((i) => i.secret)).toEqual([true, false]);
    expect(withStorage(inputs, false).map((i) => i.secret)).toEqual([false, false]);
  });
});

describe("sources and documented variables", () => {
  const rows: EnvironmentRow[] = [
    { name: "DATABASE_URL", scope: "user", overridden: true },
    { name: "DATABASE_URL", scope: "repository", overridden: false },
    { name: "LOCAL_ONLY", scope: "repository", overridden: false },
    { name: "SHARED", scope: "repositoryShared", overridden: false },
    { name: "LOCAL_FILE", scope: "repositoryLocal", overridden: false },
    { name: "NODE_OPTIONS", scope: "user", overridden: false },
    { name: "OPENAI_BASE_URL", scope: "repositoryShared", overridden: false },
  ];
  it("says where a value comes from and what it overrides", () => {
    const label = (name: string, scope: EnvironmentRow["scope"]) => appliesTo(rows.find((r) => r.name === name && r.scope === scope)!, rows, "repository");
    expect(label("DATABASE_URL", "user")).toBe("from Personal");
    expect(label("DATABASE_URL", "repository")).toBe("overrides Personal");
    expect(label("LOCAL_ONLY", "repository")).toBe("This project");
    expect(label("SHARED", "repositoryShared")).toBe(".terminalx/settings.json");
    expect(label("LOCAL_FILE", "repositoryLocal")).toBe(".terminalx/settings.local.json");
    expect(appliesTo({ name: "A", scope: "user", overridden: false }, [], "personal")).toBe("All projects");
    expect(appliesTo({ name: "A", scope: "user", overridden: false, overriddenIn: ["/code/app/.git", "/code/x/.git"] }, [], "personal", [{ name: "App", path: "/code/app" }])).toBe("overridden in App, x");
  });
  it("lists the agents' variables, then the repository files' names, with where each is set", () => {
    const documented = documentedVariables([...rows, { name: "ANTHROPIC_API_KEY", scope: "user", overridden: false }]);
    const status = Object.fromEntries(documented.map((d) => [d.name, d.status]));
    expect(status.ANTHROPIC_API_KEY).toBe("Set in Personal");
    expect(status.OPENAI_API_KEY).toBe("Not set");
    expect(status.OPENAI_BASE_URL).toBe("Set in .terminalx/settings.json");
    expect(documented.slice(-2).map((d) => [d.name, d.status, d.description])).toEqual([["LOCAL_FILE", "Set in .terminalx/settings.local.json", null], ["SHARED", "Set in .terminalx/settings.json", null]]);
    expect(documented.filter((d) => d.name === "OPENAI_BASE_URL")).toHaveLength(1);
  });
  it("names the port block among what TerminalX sets", () => {
    const names = TERMINALX_VARIABLES.flatMap((v) => v.names.split(", "));
    expect(names).toEqual(expect.arrayContaining(["TERMINALX_PORT", "TERMINALX_PORTS", "RACCOON_SESSION_ID", "TERMINALX_NEXT_TOKEN", "CODEX_HOME"]));
    for (const name of names) expect(environmentNameError(name), name).toBeTruthy();
  });
});
