import "@testing-library/dom";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), unlink: vi.fn(), setPrivate: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: vi.fn(), message: vi.fn(async () => undefined) }));
vi.mock("@/components/ui/tooltip", () => ({
  WithTooltip: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

const session: SessionEntry = {
  id: "s1",
  projectPath: "/repos/widgets",
  cwd: "/repos/widgets/.raccoon/worktrees/login",
  branch: "raccoon/login",
  worktreeRemoved: false,
  title: "Fix the login",
  created: "x",
  modified: "x",
  archived: false,
  pinned: false,
  tabs: [],
};

const issue = (id: string, title: string) => ({
  provider: "github",
  id,
  identifier: `#${id}`,
  number: Number(id),
  title,
  url: `https://github.com/acme/widgets/issues/${id}`,
  state: "OPEN",
  stateType: "open",
  labels: [],
  updatedAt: "2026-10-18T10:00:00Z",
});

let stored: SessionEntry;
let refuse: string | null;

beforeEach(() => {
  stored = structuredClone(session);
  refuse = null;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "list_projects":
        return { projects: [{ path: "/repos/widgets", name: "Widgets", kind: "git" }], lastSelected: null };
      case "list_sessions":
        return [stored];
      case "list_harnesses":
      case "list_workspaces":
        return [];
      case "issues_list":
        if (refuse) throw refuse;
        return (args.filter as { search?: string }).search ? [issue("7", "Login loops")] : [issue("7", "Login loops"), issue("9", "Dark mode")];
      case "session_link_issue":
        stored = { ...stored, issue: args.issue as SessionEntry["issue"], issueWork: { link: "manual" } };
        return stored;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(cleanup);

const called = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

async function mount() {
  vi.resetModules();
  const sessions = await import("@/lib/sessions");
  const dialogs = await import("@/lib/dialogs");
  const { SessionDialogs } = await import("./SessionDialogs");
  await sessions.bootSessions();
  render(<SessionDialogs />);
  return { sessions, dialogs };
}

describe("Link to issue…", () => {
  it("links the session to the issue picked from its project, by hand", async () => {
    const { sessions, dialogs } = await mount();
    dialogs.openLinkIssue("s1");
    expect(await screen.findByText("Link to issue")).toBeTruthy();
    fireEvent.click(await screen.findByText("Login loops"));
    await waitFor(() =>
      expect(called("session_link_issue")).toEqual([{ sessionId: "s1", issue: { provider: "github", id: "7", identifier: "#7", title: "Login loops", url: "https://github.com/acme/widgets/issues/7" } }]),
    );
    await waitFor(() => expect(screen.queryByText("Link to issue")).toBeNull());
    expect(sessions.getSessionStore().sessions[0]).toMatchObject({ issue: { identifier: "#7" }, issueWork: { link: "manual" } });
  });

  it("searches the project's issues, on either tracker", async () => {
    const { dialogs } = await mount();
    dialogs.openLinkIssue("s1");
    await screen.findByText("Dark mode");
    fireEvent.change(screen.getByRole("textbox", { name: "Search issues" }), { target: { value: "login" } });
    await waitFor(() => expect(screen.queryByText("Dark mode")).toBeNull());
    expect(called("issues_list").at(-1)).toEqual({ projectPath: "/repos/widgets", provider: "github", filter: { search: "login" } });
    fireEvent.click(screen.getByRole("radio", { name: "Linear" }));
    await waitFor(() => expect(called("issues_list").at(-1)).toMatchObject({ provider: "linear" }));
  });

  it("says why the issues could not be read", async () => {
    refuse = "This project has no GitHub remote.";
    const { dialogs } = await mount();
    dialogs.openLinkIssue("s1");
    expect((await screen.findByRole("alert")).textContent).toBe("This project has no GitHub remote.");
  });
});

describe("a session's issue menu items", () => {
  beforeEach(() => {
    mocks.unlink.mockReset().mockResolvedValue(undefined);
    mocks.setPrivate.mockReset().mockResolvedValue(undefined);
  });

  async function items(of: SessionEntry) {
    vi.resetModules();
    vi.doMock("@/components/ui/menu", () => ({
      DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => <div role="menuitem" onClick={() => onSelect?.()}>{children}</div>,
      DropdownMenuCheckboxItem: ({ children, checked, onCheckedChange }: { children: ReactNode; checked?: boolean; onCheckedChange?: (on: boolean) => void }) => (
        <div role="menuitemcheckbox" aria-checked={!!checked} onClick={() => onCheckedChange?.(!checked)}>{children}</div>
      ),
      ContextMenuItem: () => null,
      ContextMenuCheckboxItem: () => null,
    }));
    vi.doMock("@/lib/sessions", () => ({ unlinkSessionIssue: mocks.unlink, setSessionWorkPrivate: mocks.setPrivate }));
    const { useDialogs } = await import("@/lib/dialogs");
    const { IssueLinkMenuItems } = await import("./IssueLinkMenuItems");
    // Which session the link dialog was opened for.
    const Asked = () => <output data-testid="asked">{useDialogs().linkIssue ?? ""}</output>;
    render(
      <>
        <IssueLinkMenuItems session={of} />
        <Asked />
      </>,
    );
  }

  afterEach(() => {
    vi.doUnmock("@/components/ui/menu");
    vi.doUnmock("@/lib/sessions");
  });

  it("offers to link an unlinked session, and to keep its work status on this Mac", async () => {
    await items(session);
    fireEvent.click(screen.getByRole("menuitem", { name: "Link to issue…" }));
    expect(screen.getByTestId("asked").textContent).toBe("s1");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Don’t share this session" }));
    expect(mocks.setPrivate).toHaveBeenCalledWith("s1", true);
  });

  it("says how an automatic link was made, and unlinks it", async () => {
    await items({ ...session, issue: { provider: "github", id: "441", identifier: "#441", title: "T", url: "https://github.com/acme/widgets/issues/441" }, issueWork: { link: "branch", private: true } });
    fireEvent.click(screen.getByRole("menuitem", { name: "Unlink #441 (linked from its branch name)" }));
    expect(mocks.unlink).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("menuitemcheckbox", { name: "Don’t share this session" }).getAttribute("aria-checked")).toBe("true");
  });

  it("offers nothing for a quick chat, which has no project", async () => {
    await items({ ...session, kind: "quick" });
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});
