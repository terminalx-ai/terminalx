import { describe, expect, it } from "vitest";
import { MAX_REPOSITORY_IDENTITY_LENGTH, normalizeRepositoryIdentity } from "./repositoryIdentity";

// Copied exactly from terminalx-saas
// apps/api/src/services/cloudWorkspaces/workspaceConfig/workspaceConfigValidation.test.ts
describe("normalizeRepositoryIdentity (server cases)", () => {
  it("names one layer for every spelling of a repository", () => {
    for (const value of ["https://github.com/Acme/App.git", "https://github.com/acme/app", "github.com/ACME/app"])
      expect(normalizeRepositoryIdentity(value)).toBe("github.com/acme/app");
  });

  it("rejects anything that is not host/owner/name", () => {
    for (const value of ["https://github.com/acme", "https://x:y@github.com/a/b", "github.com/a/b/c", "github.com/../b", 42])
      expect(normalizeRepositoryIdentity(value)).toBeNull();
  });
});

describe("normalizeRepositoryIdentity (git remote get-url origin)", () => {
  it("gives https, ssh and scp-style remotes of one repository the same identity", () => {
    for (const value of [
      "https://github.com/Acme/App.git\n",
      "https://github.com/acme/app\n",
      "git@github.com:Acme/App.git\n",
      "git@github.com:acme/app",
      "github.com:acme/app.git",
      "git@github.com:/acme/app.git",
      "ssh://git@github.com/Acme/App.git\n",
      "ssh://git@github.com:22/acme/app.git",
      "ssh://github.com/acme/app",
      "git+ssh://git@github.com/acme/app.git",
      "ssh+git://git@github.com/acme/app.git",
    ])
      expect(normalizeRepositoryIdentity(value), value).toBe("github.com/acme/app");
  });

  it("keeps self-hosted hosts and dotted or dashed names", () => {
    expect(normalizeRepositoryIdentity("git@git.example.co:Team-1/my.repo_x.git")).toBe("git.example.co/team-1/my.repo_x");
    expect(normalizeRepositoryIdentity("ssh://git@git.example.co:2222/team-1/my.repo_x.git")).toBe(
      "git.example.co/team-1/my.repo_x",
    );
  });

  it("rejects remotes that are not exactly one host/owner/name", () => {
    for (const value of [
      "",
      "\n",
      "/Users/me/code/app",
      "../app",
      "C:/Users/me/app",
      "C:\\Users\\me\\app",
      "file:///Users/me/app.git",
      "git@github.com:acme",
      "git@github.com:acme/app/extra.git",
      "git@github.com:../app",
      "git@github.com:acme/..",
      "ssh://git@github.com/acme",
      "ssh://git@github.com/acme/app/extra",
      "ssh://git@github.com:notaport/acme/app",
      "https://token@github.com/acme/app.git",
      "https://github.com/acme/app.git?x=1",
      "https://github.com/acme/app#main",
      "https://github.com/acme/app/",
      "git@github.com:acme/app?x=1",
      "git@git hub.com:acme/app",
      null,
      undefined,
      { url: "github.com/acme/app" },
    ])
      expect(normalizeRepositoryIdentity(value), String(value)).toBeNull();
  });

  it("applies the server's length limit", () => {
    const long = `github.com/acme/${"a".repeat(MAX_REPOSITORY_IDENTITY_LENGTH)}`;
    expect(normalizeRepositoryIdentity(long)).toBeNull();
    expect(normalizeRepositoryIdentity(`git@${long.replace("/", ":")}`)).toBeNull();
  });
});
