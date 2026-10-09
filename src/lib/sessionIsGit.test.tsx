import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), projects: [] as Project[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { useSessionIsGit, resetQuickChatRepositories } = await import("./quickChats");
const sessions = await import("./sessions");

const scratch = "/home/.raccoon/quick/q1";
const base = { id: "q1", worktreeRemoved: false, title: "t", created: "x", modified: "x", archived: false, pinned: false, tabs: [] };
const quick = (cwd = scratch): SessionEntry => ({ ...base, kind: "quick", projectPath: scratch, cwd });
const ofProject = (path: string): SessionEntry => ({ ...base, id: "p1", projectPath: path, cwd: path });

function Probe({ session }: { session: SessionEntry }) {
  return <span data-testid="git">{String(useSessionIsGit(session))}</span>;
}
const shown = () => screen.getByTestId("git").textContent;
const asked = () => mocks.invoke.mock.calls.filter(([command]) => command === "work_status").map(([, args]) => (args as { cwd: string }).cwd);

beforeEach(async () => {
  resetQuickChatRepositories();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { cwd?: string; path?: string } = {}) => {
    if (command === "work_status") return { isRepo: args.cwd === "/repos/api", dirty: false, branch: null, ahead: 0, behind: 0 };
    if (command === "add_project") return { path: args.path, name: "p", kind: args.path === "/Users/me/notes" ? "folder" : "git" };
    if (command === "list_workspaces") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
  await sessions.addProject("/repos/api");
  await sessions.addProject("/Users/me/notes");
  mocks.invoke.mockClear();
});

afterEach(() => {
  cleanup();
});

/**
 * Changes, Repo and PR are for a repository. A quick chat has no project to
 * say whether it is in one, and must not get those surfaces over a scratch
 * folder: that is the "no repository" state rather than a row of git errors.
 */
describe("whether a session's folder is a repository", () => {
  it("is never one for a quick chat in its scratch folder, and no git is run to find out", async () => {
    render(<Probe session={quick()} />);
    expect(shown()).toBe("false");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked()).toEqual([]);
  });

  it("is read from the folder a quick chat was pointed at, once", async () => {
    const view = render(<Probe session={quick("/repos/api")} />);
    // Not assumed while it is being read.
    expect(shown()).toBe("false");
    await waitFor(() => expect(shown()).toBe("true"));
    view.unmount();
    render(<Probe session={quick("/Users/me/notes")} />);
    await waitFor(() => expect(asked()).toEqual(["/repos/api", "/Users/me/notes"]));
    expect(shown()).toBe("false");
  });

  it("is the project's own kind for a project session, as it always was", () => {
    const view = render(<Probe session={ofProject("/repos/api")} />);
    expect(shown()).toBe("true");
    view.rerender(<Probe session={ofProject("/Users/me/notes")} />);
    expect(shown()).toBe("false");
    // A session whose project this window does not list (a cloud one) is treated as a repository, as before.
    view.rerender(<Probe session={ofProject("/somewhere/else")} />);
    expect(shown()).toBe("true");
    expect(asked()).toEqual([]);
  });
});
