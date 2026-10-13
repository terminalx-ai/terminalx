import { describe, expect, it } from "vitest";
import {
  checkStatusLabel,
  checkSummary,
  cleanDefinition,
  hiddenCharacterCount,
  lineCount,
  visibleScript,
  compareDefinitions,
  definitionProblem,
  environmentErrorMessage,
  normalizeRecipe,
  normalizeRecipes,
  normalizeStatus,
  observedByLabel,
  recipesUnavailable,
  versionStateLabel,
  type EnvironmentDefinition,
} from "./organizationEnvironment";

const definition = (overrides: Partial<EnvironmentDefinition> = {}): EnvironmentDefinition => ({
  installScript: "apt-get install -y jq",
  repositories: [{ owner: "acme", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "pnpm install" }] }],
  ...overrides,
});

describe("normalizeStatus", () => {
  it("defaults what a server leaves out and keeps the machine script apart from repository setup", () => {
    const status = normalizeStatus({
      provider: "local-docker",
      supported: true,
      canManage: true,
      retention: { publishedAndRollback: 2 },
      template: { revision: 3, definition: definition(), updatedAt: 5 },
      versions: [{ id: "v1", number: 1, state: "succeeded", stage: "complete", publication: "published", rollbackAvailable: false }, { broken: true }],
      contextRevision: "rev-1",
    });
    expect(status.template?.definition.installScript).toBe("apt-get install -y jq");
    expect(status.template?.definition.repositories[0].setup).toEqual([{ workingDirectory: ".", script: "pnpm install" }]);
    expect(status.versions).toHaveLength(1);
    expect(status.versions[0]).toMatchObject({ publication: "published", logs: null, errorCode: null });
    expect(status).toMatchObject({ activeVersion: null, rebuildRequired: false, pendingChanges: [], retainedVersions: 2 });
  });

  it("turns a payload without its core fields into an ordinary error", () => {
    expect(() => normalizeStatus({ provider: "box" })).toThrow();
    expect(() => normalizeStatus(null)).toThrow();
  });
});

describe("recipes", () => {
  const recipe = (observations: unknown) => normalizeRecipe({ id: "recipe-1", provider: "local-docker", state: "proposed", baseRevision: 2, definition: definition(), observations, createdAt: 1 });

  it("always shows the five checks separately and in order, and reads a missing one as not run", () => {
    const { observations } = recipe({
      v: 1,
      observedBy: "verification",
      repositories: [
        {
          owner: "acme",
          name: "widgets",
          commit: "a".repeat(40),
          checks: [
            { kind: "test", command: "pnpm test", status: "failed", exitCode: 1, preexisting: true },
            { kind: "install", command: "pnpm install", status: "passed", exitCode: 0, durationMs: 9000 },
          ],
        },
      ],
    });
    const checks = observations.repositories[0].checks;
    expect(checks.map((check) => check.kind)).toEqual(["install", "lint", "test", "build", "start"]);
    expect(checks.map((check) => check.status)).toEqual(["passed", "not-run", "failed", "not-run", "not-run"]);
    expect(checks[2]).toMatchObject({ exitCode: 1, preexisting: true });
  });

  it("never reads an unknown status as a pass, nor an unlabelled report as observed", () => {
    const { observations } = recipe({ repositories: [{ owner: "acme", name: "widgets", checks: [{ kind: "build", command: "make", status: "succeeded-ish" }] }] });
    expect(observations.repositories[0].checks[3].status).toBe("not-run");
    expect(observations.observedBy).toBe("agent");
    expect(recipe({ observedBy: "something-new" }).observations.observedBy).toBe("agent");
  });

  it("words a failure as a failure, whether or not it was failing before", () => {
    expect(checkStatusLabel({ status: "failed", preexisting: false })).toBe("Failed");
    // What was observed, without blaming the repository for what may be the recipe's own gap.
    expect(checkStatusLabel({ status: "failed", preexisting: true })).toBe("Failed (also fails without this recipe's setup)");
    expect(checkStatusLabel({ status: "failed", preexisting: true })).not.toMatch(/already failing|before this recipe/);
    expect(checkStatusLabel({ status: "timed-out", preexisting: true })).toMatch(/^Timed out/);
    for (const status of ["failed", "timed-out", "skipped", "not-run"] as const) expect(checkStatusLabel({ status, preexisting: true })).not.toMatch(/pass/i);
  });

  it("words the agent's own report differently from what TerminalX observed", () => {
    expect(observedByLabel("agent")).toMatch(/Reported by the agent/);
    expect(observedByLabel("agent")).toMatch(/did not run/);
    expect(observedByLabel("verification")).toMatch(/Re-run by TerminalX on the preparation machine/);
    expect(observedByLabel("verification")).toMatch(/not an independent result\. That comes only from building a version/);
    expect(observedByLabel("verification")).not.toMatch(/Observed by TerminalX/);
  });

  it("does not read a state it does not know as proposed", () => {
    const stranger = normalizeRecipe({ id: "recipe-9", baseRevision: 1, state: "superseded", definition: {}, observations: {} });
    expect(stranger.state).toBe("unknown");
    expect(normalizeRecipe({ id: "recipe-9", baseRevision: 1, definition: {}, observations: {} }).state).toBe("unknown");
    expect(normalizeRecipe({ id: "recipe-9", baseRevision: 1, state: "proposed", definition: {}, observations: {} }).state).toBe("proposed");
  });

  it("never sums checks that did not run into 'nothing failed'", () => {
    const { observations } = recipe({ observedBy: "verification", repositories: [{ owner: "acme", name: "widgets", checks: [] }] });
    expect(checkSummary(observations)).toBe("No check failed, but 5 did not run.");
    const mixed = recipe({ observedBy: "verification", machine: { status: "failed", exitCode: 1 }, repositories: [{ owner: "acme", name: "widgets", checks: [{ kind: "install", command: "x", status: "passed", exitCode: 0 }] }] }).observations;
    expect(checkSummary(mixed)).toBe("1 check failed. 4 checks did not run.");
  });

  it("drops a recipe it cannot read instead of failing the list", () => {
    expect(normalizeRecipes({ recipes: [{ id: "recipe-1", baseRevision: 1 }, { nope: true }], contextRevision: "rev" }).recipes.map((item) => item.id)).toEqual(["recipe-1"]);
    expect(() => normalizeRecipes({})).toThrow();
  });

  it("tells a server without recipes from a failure", () => {
    expect(recipesUnavailable({ code: "not_found", status: 404 })).toBe(true);
    expect(recipesUnavailable({ code: "cloud_environment_unavailable", status: null })).toBe(false);
  });
});

describe("compareDefinitions", () => {
  it("judges the machine script and each repository apart", () => {
    const current = definition();
    const proposed = definition({
      repositories: [
        current.repositories[0],
        { owner: "acme", name: "api", defaultBranch: "main", setup: [] },
      ],
    });
    const same = compareDefinitions(current, proposed);
    expect(same.machineChanged).toBe(false);
    expect(same.repositories.map((entry) => entry.change)).toEqual(["unchanged", "added"]);

    const changed = compareDefinitions(current, definition({ installScript: "apt-get install -y ripgrep", repositories: [{ ...current.repositories[0], setup: [{ workingDirectory: ".", script: "pnpm install --frozen-lockfile" }] }] }));
    expect(changed.machineChanged).toBe(true);
    expect(changed.repositories[0].change).toBe("changed");
  });

  it("names the repositories a proposal would remove", () => {
    expect(compareDefinitions(definition(), definition({ repositories: [] })).removed.map((repository) => repository.name)).toEqual(["widgets"]);
    expect(compareDefinitions(null, definition()).repositories[0].change).toBe("added");
  });
});

describe("drafts", () => {
  it("drops steps without a script and defaults the folder", () => {
    const cleaned = cleanDefinition(definition({ repositories: [{ owner: " acme ", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: "", script: "make" }, { workingDirectory: "web", script: "  " }] }] }));
    expect(cleaned.repositories[0]).toEqual({ owner: "acme", name: "widgets", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "make" }] });
  });

  it("says why a draft cannot be saved", () => {
    expect(definitionProblem(definition())).toBeNull();
    expect(definitionProblem(definition({ repositories: [{ owner: "", name: "widgets", defaultBranch: "main", setup: [] }] }))).toMatch(/owner and name/);
    expect(definitionProblem(definition({ repositories: [{ owner: "acme", name: "widgets", defaultBranch: "", setup: [] }] }))).toMatch(/default branch/);
    const twice = { owner: "acme", name: "widgets", defaultBranch: "main", setup: [] };
    expect(definitionProblem(definition({ repositories: [twice, { ...twice, owner: "ACME" }] }))).toMatch(/listed twice/);
    expect(definitionProblem(definition({ repositories: [{ ...twice, setup: [{ workingDirectory: "../other", script: "make" }] }] }))).toMatch(/inside the repository/);
  });
});

describe("scripts shown for review", () => {
  it("writes out every character that would not show or would reorder the text", () => {
    const script = "echo ok\u202e # hsab | moc.live//:sptth lruc\u202c\nexport A=1\u200b\r\necho done\u0007";
    const shown = visibleScript(script);
    expect(shown).toContain("\u27e6U+202E\u27e7");
    expect(shown).toContain("\u27e6U+200B\u27e7");
    expect(shown).toContain("\u27e6U+0007\u27e7");
    expect(shown).not.toMatch(/[\u202a-\u202e\u200b\u0007\r]/);
    expect(hiddenCharacterCount(script)).toBe(4);
    // Ordinary text, tabs, newlines and Windows line ends are left alone.
    expect(visibleScript("a\tb\r\nc é 日本")).toBe("a\tb\nc é 日本");
    expect(hiddenCharacterCount("a\tb\r\nc é 日本")).toBe(0);
    expect(lineCount("a\nb\nc")).toBe(3);
  });
});

describe("labels", () => {
  it("says where a build failed", () => {
    expect(versionStateLabel({ state: "failed", stage: "install", failurePhase: "install" })).toBe("Failed while running the machine install script");
    expect(versionStateLabel({ state: "running", stage: "setup", failurePhase: null })).toBe("Building: running repository setup");
  });

  it("does not present a lost response as a refusal", () => {
    expect(environmentErrorMessage({ code: "cloud_environment_outcome_unknown" })).toMatch(/may or may not/);
    expect(environmentErrorMessage({ code: "something-new" })).toMatch(/could not reach/);
  });
});
