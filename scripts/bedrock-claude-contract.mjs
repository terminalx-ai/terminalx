// Source-contract coverage only: reads an explicitly supplied installed CLI,
// never runs it or reads its configuration/credential caches. This does not
// replace a real Claude startup/reload/resume test on the deployed platform.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export function reviewedArtifact(artifact) {
  const bytes = readFileSync(artifact);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "1f53587e92dee8e089fa349188a4cda64fa34ace6e7b0ca2ee278ddaa3cc2ebd",
    "Unreviewed Claude artifact: establish its host-settings contract first",
  );
  return bytes.toString("utf8");
}

export function hostProviderPredicate(artifact) {
  const source = reviewedArtifact(artifact);
  const declarations = new Map();
  function array(name, set = false) {
    if (declarations.has(name)) return;
    const marker = `${name}=${set ? "new Set(" : ""}[`;
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `Missing ${name}`);
    const from = start + marker.length - 1;
    const to = source.indexOf("]", from);
    const expression = source.slice(from, to + 1);
    // These exact artifact tables contain string literals and array spreads;
    // do not evaluate arbitrary extracted initialization code.
    assert.match(expression, /^\[(?:"[A-Z0-9_]+"|\.\.\.[A-Za-z0-9_$]+|,)*\]$/);
    for (const [, dependency] of expression.matchAll(/\.\.\.([A-Za-z0-9_$]+)/g))
      array(dependency);
    declarations.set(
      name,
      `const ${name}=${set ? "new Set(" : ""}${expression}${set ? ")" : ""};`,
    );
  }
  array("T_", true);
  array("qLr");
  array("P_");
  const predicate = source.match(/function kln\(e\)\{[^{}]+\}/)?.[0];
  assert.ok(predicate);
  // Verify that this exact predicate is in the real settings-env filter,
  // including policy and flag settings, not just an unrelated allowlist.
  assert.ok(
    source.includes(
      "if(kln(s)&&(E.managedByHost||!zFs(s))){if(E.managedByHost)G(r,s,n);continue}",
    ),
  );
  return runInNewContext(
    `${[...declarations.values()].join("\n")}\n${predicate}\nkln`,
    Object.create(null),
    { timeout: 1000 },
  );
}
