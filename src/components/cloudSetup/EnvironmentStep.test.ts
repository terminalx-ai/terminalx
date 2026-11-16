import { describe, expect, it } from "vitest";
import { chosenRepositories, draftOf } from "./EnvironmentStep";

describe("the Environment step's repositories", () => {
  it("offers only the repositories chosen in the GitHub step that are still reachable", () => {
    expect(
      chosenRepositories([
        { fullName: "acme/app", state: "accessible", defaultBranch: "main" },
        { fullName: "acme/gone", state: "missing", defaultBranch: "main" },
        { fullName: "acme/paused", state: "installation-suspended" },
        { fullName: "acme/api", state: "accessible" },
      ]),
    ).toEqual([
      { owner: "acme", name: "app", defaultBranch: "main" },
      { owner: "acme", name: "api", defaultBranch: "" },
    ]);
  });

  it("drops template repositories no longer chosen, keeps the saved order and a multi-step setup as it is", () => {
    const saved = {
      installScript: "apt-get install -y jq",
      repositories: [
        { owner: "acme", name: "old", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "make" }] },
        { owner: "acme", name: "api", defaultBranch: "main", setup: [{ workingDirectory: "server", script: "npm ci" }, { workingDirectory: ".", script: "make" }] },
        { owner: "acme", name: "app", defaultBranch: "main", setup: [{ workingDirectory: ".", script: "bun install" }] },
      ],
    };
    const chosen = [
      { owner: "acme", name: "new", defaultBranch: "trunk" },
      { owner: "acme", name: "app", defaultBranch: "main" },
      { owner: "acme", name: "api", defaultBranch: "main" },
    ];
    const draft = draftOf(saved, chosen, { revision: 1, scripts: { "acme/app": "bun install --frozen-lockfile" } });
    expect(draft.installScript).toBe("apt-get install -y jq");
    expect(draft.repositories.map((repository) => repository.name)).toEqual(["api", "app", "new"]);
    expect(draft.repositories[0]!.setup).toEqual(saved.repositories[1]!.setup);
    expect(draft.repositories[1]!.setup).toEqual([{ workingDirectory: ".", script: "bun install --frozen-lockfile" }]);
    expect(draft.repositories[2]).toEqual({ owner: "acme", name: "new", defaultBranch: "trunk", setup: [{ workingDirectory: ".", script: "" }] });
  });
});
