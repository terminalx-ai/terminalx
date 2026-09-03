import { describe, expect, it } from "vitest";
import {
  buildPaletteIndex,
  movePaletteSelection,
  parseSmartInput,
  searchPaletteIndex,
} from "./commandPalette";
import type { HarnessInfo, Project, SessionEntry, Workspace } from "@/types/session";

const projects: Project[] = [
  { path: "/code/raccoon", name: "Raccoon", lastOpened: "2026-09-01T00:00:00Z" },
  { path: "/code/site", name: "Website", lastOpened: "2026-08-01T00:00:00Z" },
];

const harnesses: HarnessInfo[] = [
  {
    id: "codex",
    name: "Codex",
    binary: "codex",
    available: true,
    installHint: "",
    installUrl: "",
    caps: { images: true, steer: true, permissionModes: true, effort: true, slashCommands: true, atMentions: true, fork: false, resume: true },
  },
];

const sessions: SessionEntry[] = [
  {
    id: "older",
    projectPath: "/code/raccoon",
    cwd: "/code/raccoon/.raccoon/worktrees/login",
    branch: "feature/login",
    worktreeRemoved: false,
    title: "Fix login redirect",
    created: "2026-08-30T00:00:00Z",
    modified: "2026-09-01T00:00:00Z",
    archived: false,
    pinned: false,
    tabs: [{ id: "tab-1", harness: "codex", model: "gpt", permissionMode: "auto", status: "idle", created: "", modified: "" }],
  },
  {
    id: "newer",
    projectPath: "/code/site",
    cwd: "/code/site",
    branch: "main",
    worktreeRemoved: false,
    title: "Landing page",
    created: "2026-09-02T00:00:00Z",
    modified: "2026-09-03T00:00:00Z",
    archived: false,
    pinned: false,
    tabs: [],
  },
];

const workspace: Workspace = {
  path: "/code/raccoon/.raccoon/worktrees/login",
  name: "login",
  branch: "feature/login",
  head: "abc",
  isMain: false,
  managed: true,
  uncommitted: 0,
  additions: 0,
  deletions: 0,
  unpushed: 1,
  ahead: 2,
  behind: 1,
};

describe("command palette index", () => {
  it("groups real store entities with their searchable secondary lines", () => {
    const index = buildPaletteIndex(sessions, projects, { "/code/raccoon": [workspace] }, harnesses);

    expect(index.sessions).toHaveLength(2);
    expect(index.workspaces[0].secondary).toBe("Raccoon · ↑2 ↓1");
    expect(index.projects.map((item) => item.primary)).toEqual(["Website", "Raccoon"]);
    expect(index.sessions.find((item) => item.sessionId === "older")?.secondary).toContain("Codex");
  });

  it("puts recent items first when empty and exact title matches first when searched", () => {
    const index = buildPaletteIndex(sessions, projects, { "/code/raccoon": [workspace] }, harnesses);

    expect(searchPaletteIndex(index, "").sessions.map((match) => match.item.sessionId)).toEqual(["newer", "older"]);
    const matches = searchPaletteIndex(index, "login").sessions;
    expect(matches[0].item.sessionId).toBe("older");
    expect(matches[0].primaryRanges).toEqual([{ start: 4, end: 9 }]);
  });
});

describe("smart palette input", () => {
  it("parses GitHub issue and pull request URLs plus shorthand numbers", () => {
    expect(parseSmartInput("https://github.com/terminalx-ai/raccoon/issues/46")).toMatchObject({
      kind: "github",
      type: "issue",
      number: 46,
      owner: "terminalx-ai",
      repo: "raccoon",
    });
    expect(parseSmartInput("https://github.com/terminalx-ai/raccoon/pull/51/files")).toMatchObject({ kind: "github", type: "pull", number: 51 });
    expect(parseSmartInput("#123")).toEqual({ kind: "github", type: "issue", number: 123, owner: null, repo: null, url: null });
  });

  it("parses absolute filesystem paths without mistaking ordinary searches for paths", () => {
    expect(parseSmartInput("/code/raccoon/")).toEqual({ kind: "path", path: "/code/raccoon" });
    expect(parseSmartInput("file:///code/raccoon%20next")).toEqual({ kind: "path", path: "/code/raccoon next" });
    expect(parseSmartInput("raccoon")).toBeNull();
  });
});

describe("palette keyboard navigation", () => {
  it("loops with arrows and supports Home and End", () => {
    expect(movePaletteSelection(-1, 3, "ArrowDown")).toBe(0);
    expect(movePaletteSelection(2, 3, "ArrowDown")).toBe(0);
    expect(movePaletteSelection(0, 3, "ArrowUp")).toBe(2);
    expect(movePaletteSelection(1, 3, "Home")).toBe(0);
    expect(movePaletteSelection(1, 3, "End")).toBe(2);
    expect(movePaletteSelection(0, 0, "ArrowDown")).toBe(-1);
  });
});
