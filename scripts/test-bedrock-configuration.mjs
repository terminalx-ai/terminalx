// Offline path contract only. No Claude process or user config/cache is opened.
// The Rust session_bedrock_config_tests separately exercise real SessionManager
// start_cli -> claude_launch -> trust preparation -> PTY fixture observation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  reviewedArtifact,
  hostProviderPredicate,
} from "./bedrock-claude-contract.mjs";

const source = reviewedArtifact(process.argv[2]);
const globalStart = source.indexOf("function PFr(){");
const globalPath = source.slice(
  globalStart,
  source.indexOf("function hh(){", globalStart),
);
assert.equal(
  globalPath,
  "function PFr(){let o=`.claude${kj()}.json`;return l(process.env.CLAUDE_CONFIG_DIR||Z_(),o)}",
);
const suffixStart = source.indexOf("function kj(){");
const suffix = source.slice(
  suffixStart,
  source.indexOf("function Yjs(){", suffixStart),
);
assert.equal(
  suffix,
  'function kj(){if(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL)return"-custom-oauth";switch(E()){case"local":return"-local-oauth";case"staging":return"-staging-oauth";case"prod":return""}}',
);
const modeStart = source.lastIndexOf("function E(){", suffixStart);
const mode = source.slice(modeStart, source.indexOf("var xxe=", modeStart));
assert.equal(mode, 'function E(){return"prod"}');
const selectedStart = source.lastIndexOf("function $_(){", globalStart);
const selectedPath = source.slice(selectedStart, globalStart);
assert.ok(
  selectedPath.startsWith(
    'function $_(){if(q())return{file:PFr()};let o=l(Ue(),".config.json"),_=PFr();',
  ),
);
assert.ok(selectedPath.endsWith("catch{}return{file:_}}"));
const userPath = source.match(
  /var Ue=f\((\(\)=>\(Dcn\(\)\?\?u\(D\(\),"\.claude"\)\)\.normalize\("NFC"\)),Dcn\)/,
)?.[1];
assert.ok(userPath, "User-root resolver changed; review the artifact contract");

function paths(
  home,
  overrideDir,
  extraEnv = {},
  legacy = false,
  existingGlobal = false,
) {
  const env = {
    ...extraEnv,
    ...(overrideDir === null ? {} : { CLAUDE_CONFIG_DIR: overrideDir }),
  };
  const user = (overrideDir ?? posix.join(home, ".claude")).normalize("NFC");
  // Only synthetic metadata reaches the actual legacy-file selector. Never
  // give the VM a real filesystem or the process's environment.
  const legacyFile = posix.join(user, ".config.json");
  const fs = {
    statSync(file) {
      if (legacy && file === legacyFile)
        return { isFile: () => true, size: 80, mode: 0o600, dev: 1, ino: 1 };
      if (existingGlobal)
        return { isFile: () => true, size: 90, mode: 0o600, dev: 1, ino: 2 };
      const error = new Error("synthetic missing file");
      error.code = "ENOENT";
      throw error;
    },
    readdirSync: () => [{ name: ".config.json" }],
  };
  const actualSuffix = runInNewContext(
    `${mode}; ${suffix}; kj`,
    { process: { env } },
    { timeout: 1000 },
  );
  const result = runInNewContext(
    `${globalPath}; ${selectedPath}; const Ue = ${userPath}; ({ globalFile: $_().file, userDir: Ue() })`,
    {
      process: { env },
      l: posix.join,
      Z_: () => home,
      kj: actualSuffix,
      Dcn: () => env.CLAUDE_CONFIG_DIR,
      u: posix.join,
      D: () => home,
      q: () => false,
      ie: () => fs,
      V: (error) => error.code === "ENOENT",
      E: (error) => error.code,
      t: () => {},
      x: () => "linux",
      Q_: posix.dirname,
      J_: posix.basename,
    },
    { timeout: 1000 },
  );
  return { globalFile: result.globalFile, userDir: result.userDir };
}

const cases = JSON.parse(
  readFileSync(
    new URL(
      "../src-tauri/src/harness/claude/fixtures/configuration-paths.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
for (const value of cases) {
  test(`${value.name}: artifact global/user paths (Rust fixture requires ${value.admitted ? "admission" : "rejection before access"})`, () => {
    assert.deepEqual(paths(value.home, value.overrideDir), {
      globalFile: value.globalFile,
      userDir: value.userDir,
    });
  });
}
test("negative control: setting the default directory displaces the original global config", () => {
  const value = cases[0];
  assert.notEqual(
    paths(value.home, value.userDir).globalFile,
    value.globalFile,
  );
});

for (const custom of [false, true]) {
  const home = "/synthetic/home";
  const config = custom ? "/synthetic/custom" : null;
  for (const value of [undefined, "", "https://synthetic.invalid", "0", " "]) {
    test(`actual OAuth suffix resolver: ${custom ? "custom" : "default"} root, selector ${JSON.stringify(value)}`, () => {
      const env = {
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        CLAUDE_CODE_USE_BEDROCK: "1",
      };
      if (value !== undefined) env.CLAUDE_CODE_CUSTOM_OAUTH_URL = value;
      assert.equal(
        paths(home, config, env).globalFile,
        posix.join(
          config ?? home,
          value ? ".claude-custom-oauth.json" : ".claude.json",
        ),
      );
    });
  }
  test(`actual global selector prefers legacy config: ${custom ? "custom" : "default"}`, () => {
    const env = { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://synthetic.invalid" };
    assert.equal(
      paths(home, config, env, true).globalFile,
      posix.join(config ?? posix.join(home, ".claude"), ".config.json"),
    );
  });
}
for (const config of [null, "/synthetic/custom"]) {
  test(`actual legacy selection with a separate existing global candidate: ${config ?? "default"}`, () => {
    const env = { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://synthetic.invalid" };
    assert.equal(
      paths("/synthetic/home", config, env, true, true).globalFile,
      posix.join(config ?? "/synthetic/home/.claude", ".config.json"),
    );
  });
}
test("host provider filtering does not admit a custom OAuth namespace", () => {
  assert.equal(
    hostProviderPredicate(process.argv[2])("CLAUDE_CODE_CUSTOM_OAUTH_URL"),
    false,
  );
});
test("actual secure-storage resolver distinguishes empty from absent for a custom root", () => {
  const resolver = source.match(/function \$U\(\)\{[^{}]+\}/)?.[0];
  assert.equal(
    resolver,
    'function $U(){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;if(e!==void 0)return(e||u(o(),".claude")).normalize("NFC");return Ue()}',
  );
  const resolve = (env) =>
    runInNewContext(
      `${resolver}; $U()`,
      {
        process: { env },
        u: posix.join,
        o: () => "/synthetic/home",
        Ue: () => "/synthetic/custom",
      },
      { timeout: 1000 },
    );
  assert.equal(resolve({}), "/synthetic/custom");
  assert.equal(
    resolve({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }),
    "/synthetic/home/.claude",
  );
});
test("actual project namespace resolver can replace the cwd-derived namespace", () => {
  const start = source.indexOf(
    "function l(){return process.env.CLAUDE_CODE_PROJECT_DIR_NAME}",
  );
  assert.ok(start >= 0);
  const helpers = source.slice(start, source.indexOf("function S(){", start));
  const resolver = source.match(
    /var o6n=f\((\(\)=>Dcn\(\)\|\|nle\(\)\?n2s\(l\(\)\):void 0),S\)/,
  )?.[1];
  assert.ok(resolver);
  const resolve = (config) =>
    runInNewContext(
      `${helpers}; (${resolver})()`,
      {
        process: {
          env: { CLAUDE_CODE_PROJECT_DIR_NAME: "synthetic-alternate" },
        },
        Dcn: () => config,
        nle: () => false,
      },
      { timeout: 1000 },
    );
  assert.equal(resolve(undefined), undefined);
  assert.equal(resolve("/synthetic/custom"), "synthetic-alternate");
});
test("negative control: an empty override is not equivalent to absence for user settings", () => {
  const value = cases[0];
  assert.equal(paths(value.home, "").globalFile, value.globalFile);
  assert.equal(paths(value.home, "").userDir, "");
  assert.notEqual(paths(value.home, "").userDir, value.userDir);
});
