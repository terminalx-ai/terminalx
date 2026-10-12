import { describe, expect, it } from "vitest";
import {
  checkStatusLabel,
  cleanDefinition,
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
    expect(checkStatusLabel({ status: "failed", preexisting: true })).toBe("Failed (already failing before this recipe)");
    expect(checkStatusLabel({ status: "timed-out", preexisting: true })).toMatch(/^Timed out/);
    for (const status of ["failed", "timed-out", "skipped", "not-run"] as const) expect(checkStatusLabel({ status, preexisting: true })).not.toMatch(/pass/i);
  });

  it("words the agent's own report differently from what TerminalX observed", () => {
    expect(observedByLabel("agent")).toMatch(/Reported by the agent/);
    expect(observedByLabel("agent")).toMatch(/did not run/);
    expect(observedByLabel("verification")).toMatch(/Observed by TerminalX/);
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
