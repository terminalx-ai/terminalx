import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), projects: [] as Project[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { useSessionIsGit, resetQuickChatRepositories } = await import("./quickChats");
const sessions = await import("./sessions");

const scratch = "/home/.raccoon/quick/q1";
const chatsPath = "/home/.raccoon/Chats";
const base = { id: "q1", worktreeRemoved: false, title: "t", created: "x", modified: "x", archived: false, pinned: false, tabs: [] };
const quick = (cwd = scratch): SessionEntry => ({ ...base, kind: "quick", projectPath: scratch, cwd });
const ofProject = (path: string): SessionEntry => ({ ...base, id: "p1", projectPath: path, cwd: path });

const gitSurface = vi.fn();
function Probe({ session, local = true }: { session: SessionEntry; local?: boolean }) {
  const isGit = useSessionIsGit(session, local);
  // Git surfaces start reading as soon as this hook enables them.
  useEffect(() => { if (isGit) gitSurface(session.cwd); }, [isGit, session.cwd]);
  return <span data-testid="git">{String(isGit)}</span>;
}
const shown = () => screen.getByTestId("git").textContent;
const asked = () => mocks.invoke.mock.calls.filter(([command]) => command === "work_status").map(([, args]) => (args as { cwd: string }).cwd);

beforeEach(async () => {
  resetQuickChatRepositories();
  gitSurface.mockClear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { cwd?: string; path?: string; req?: { projectPath: string; cwd: string } } = {}) => {
    if (command === "work_status") return { isRepo: args.cwd === "/repos/api", dirty: false, branch: null, ahead: 0, behind: 0 };
    if (command === "add_project") return { path: args.path, name: "p", kind: args.path === "/Users/me/notes" ? "folder" : "git" };
    if (command === "list_workspaces") return [];
    if (command === "chats_dir") return chatsPath;
    if (command === "create_session") {
      const { req } = args;
      if (!req) throw new Error("create_session requires a request");
      return { ...base, id: "chat", projectPath: req.projectPath, cwd: req.cwd };
    }
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
    expect(asked()).toEqual([]);
  });

  it("leaves unlisted cloud projects to remote Git handling without probing local paths", () => {
    render(<Probe session={ofProject("/somewhere/else")} local={false} />);
    expect(shown()).toBe("true");
    expect(asked()).toEqual([]);
  });

  it("checks an unlisted local folder without requiring project metadata", async () => {
    render(<Probe session={ofProject("/unlisted/folder")} />);
    expect(shown()).toBe("false");
    await waitFor(() => expect(asked()).toEqual(["/unlisted/folder"]));
    expect(gitSurface).not.toHaveBeenCalled();
  });

  it.each([undefined, "/Users/me/notes", "/repos/api"])("checks the actual folder of a new ordinary chat in %s", async (cwd) => {
    const session = await sessions.createChat({ title: "Keep this chat", cwd });
    render(<Probe session={session} />);
    expect(shown()).toBe("false");
    expect(gitSurface).not.toHaveBeenCalled();
    await waitFor(() => expect(asked()).toEqual([cwd ?? chatsPath]));
    await waitFor(() => expect(shown()).toBe(String(cwd === "/repos/api")));
    if (cwd === "/repos/api") expect(gitSurface).toHaveBeenCalledWith(cwd);
    else expect(gitSurface).not.toHaveBeenCalled();
  });

  it("does not enable Git surfaces with the previous folder's result while switching chats", async () => {
    const repo = await sessions.createChat({ cwd: "/repos/api" });
    const folder = await sessions.createChat({ cwd: "/Users/me/notes" });
    const view = render(<Probe session={repo} />);
    await waitFor(() => expect(shown()).toBe("true"));
    gitSurface.mockClear();
    view.rerender(<Probe session={folder} />);
    expect(shown()).toBe("false");
    await waitFor(() => expect(asked()).toEqual([repo.cwd, folder.cwd]));
    expect(gitSurface).not.toHaveBeenCalled();
  });

  it("keeps Git surfaces disabled when probing an ordinary chat fails", async () => {
    const session = await sessions.createChat({ cwd: "/unreadable" });
    mocks.invoke.mockRejectedValueOnce(new Error("Folder is unavailable"));
    await act(async () => { render(<Probe session={session} />); });
    expect(asked()).toEqual([session.cwd]);
    expect(shown()).toBe("false");
    expect(gitSurface).not.toHaveBeenCalled();
  });

  it("ignores a late repository result after the ordinary chat's folder changes", async () => {
    const repo = await sessions.createChat({ cwd: "/repos/api" });
    const folder = await sessions.createChat({ cwd: "/Users/me/notes" });
    let resolve!: (status: { isRepo: boolean }) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<Probe session={repo} />);
    view.rerender(<Probe session={folder} />);
    await waitFor(() => expect(asked()).toEqual([repo.cwd, folder.cwd]));
    await act(async () => { resolve({ isRepo: true }); });
    expect(shown()).toBe("false");
    expect(gitSurface).not.toHaveBeenCalled();
  });

  it("checks a chosen folder even when the shared Chats path is an attached Git project", async () => {
    await sessions.addProject(chatsPath);
    const session = await sessions.createChat({ cwd: "/Users/me/notes" });
    render(<Probe session={session} />);
    expect(shown()).toBe("false");
    await waitFor(() => expect(asked()).toEqual([session.cwd]));
    expect(gitSurface).not.toHaveBeenCalled();
  });
});
