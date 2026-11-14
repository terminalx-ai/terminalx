import { expect, it } from "vitest";
import { rootCheckout, worktreeCheckout } from "./checkout";
import type { SessionEntry, Workspace } from "@/types/session";

const ws = (path: string, branch: string, isMain: boolean) => ({ path, name: path, branch, head: "abc1234", isMain, managed: !isMain, uncommitted: 0, additions: 0, deletions: 0 }) as Workspace;
const workspaces = { "/repo": [ws("/repo", "dc/design-tweaks", true), ws("/repo/.raccoon/worktrees/calm", "fix/tabs", false)] };
const session = (patch: Partial<SessionEntry>) => ({ id: "s", projectPath: "/repo", cwd: "/repo", branch: "dc/panel-slide", ...patch }) as SessionEntry;

it("reads the project's own checkout live for a conversation in it, not the branch it started on", () => {
  expect(rootCheckout(session({}), workspaces)?.branch).toBe("dc/design-tweaks");
  expect(worktreeCheckout(session({}), workspaces)).toBeUndefined();
});

it("leaves a worktree's conversation to its own worktree", () => {
  const inWorktree = session({ cwd: "/repo/.raccoon/worktrees/calm", worktreeName: "calm" });
  expect(rootCheckout(inWorktree, workspaces)).toBeUndefined();
  expect(worktreeCheckout(inWorktree, workspaces)?.branch).toBe("fix/tabs");
  expect(rootCheckout(session({ worktreeRemoved: true }), workspaces)).toBeUndefined();
});
