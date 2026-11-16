import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, Workspace } from "@/types/session";
import { clearDrafts, setDraft } from "@/lib/drafts";
import { setPrefs } from "@/lib/prefs";

const mocks = vi.hoisted(() => ({
  workspaces: {} as Record<string, Workspace[]>,
  sessions: [] as SessionEntry[],
  panes: [] as { id: string; sessionId: string; exited: boolean; owned?: boolean }[],
  ports: vi.fn(), busy: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ pty: { busy: mocks.busy, listeningSessions: mocks.ports } }));
vi.mock("@/lib/terminal", () => ({ useTerminals: () => ({ panes: mocks.panes }) }));
vi.mock("@/lib/sessions", () => ({
  useSessionStore: () => ({ workspaces: mocks.workspaces, sessions: mocks.sessions }),
  conversationTitle: (session: SessionEntry) => session.tabs[0]?.title ?? session.title,
  refreshWorkspaces: mocks.refresh,
  archiveSession: vi.fn(),
}));
const { DraftPreview, SessionRowData, SessionRowExtras, useSessionDraft } = await import("./SessionRowExtras");
const session: SessionEntry = {
  id: "s", title: "First request", projectPath: "/repo", cwd: "/repo/topic", worktreeName: "topic", created: "", modified: "", archived: false, pinned: false, worktreeRemoved: false, activeTab: "t",
  tabs: [{ id: "t", harness: "claude", model: "", permissionMode: "auto", status: "idle", created: "", modified: "" }],
};
function Draft() { return <DraftPreview text={useSessionDraft([session])} />; }
beforeEach(() => {
  mocks.sessions = [session];
  mocks.workspaces = { "/repo": [{ path: "/repo/topic", additions: 2, deletions: 1, branchAdditions: 21, branchDeletions: 6 } as Workspace] };
  mocks.panes = [];
  mocks.busy.mockReset().mockResolvedValue([]);
  mocks.ports.mockReset().mockResolvedValue([]);
  mocks.refresh.mockReset();
  setPrefs({ colourLineCounts: false });
});
afterEach(() => { cleanup(); clearDrafts(() => true); });

describe("sidebar row extras", () => {
  it("uses branch totals once per workspace, updates with the store, and colours only selected rows unless enabled", () => {
    const peers = [session, { ...session, id: "peer" }];
    const { rerender } = render(<SessionRowExtras sessions={peers} selected={false} />);
    expect(screen.getByText("+21").className).toBe("text-faint");
    expect(screen.getByText("−6")).toBeTruthy();
    act(() => setPrefs({ colourLineCounts: true }));
    expect(screen.getByText("+21").className).toBe("text-add");
    expect(screen.getByText("−6").className).toBe("text-destructive");
    mocks.workspaces["/repo"][0].branchAdditions = 34;
    rerender(<SessionRowExtras sessions={peers} selected />);
    expect(screen.getByText("+34")).toBeTruthy();
    rerender(<SessionRowExtras sessions={[{ ...session, worktreeRemoved: true }]} selected />);
    expect(screen.queryByText("+34")).toBeNull();
  });
  it("shows edits in inactive drafts, prefers the active draft, and removes the preview when forgotten", () => {
    render(<Draft />);
    expect(screen.queryByTestId("row-draft")).toBeNull();
    act(() => setDraft("t", "  Please\n  finish the tests  "));
    const line = screen.getByTestId("row-draft");
    // A pencil named "Draft" leads the text, in the line's faint colour; there is no "Draft:" word.
    expect(line.textContent).toBe("Please finish the tests");
    const pencil = within(line).getByRole("img", { name: "Draft" });
    expect(pencil.getAttribute("title")).toBe("Draft");
    expect(pencil.querySelector("svg")).toBeTruthy();
    expect(line.firstElementChild).toBe(pencil);
    expect(line.className).toContain("text-faint");
    expect(line.innerHTML).not.toContain("text-warning");
    act(() => clearDrafts((id) => id === "t"));
    expect(screen.queryByTestId("row-draft")).toBeNull();
  });
  it("reads shell activity in one batch and never counts an agent terminal or an exited shell", async () => {
    mocks.panes = [{ id: "shell", sessionId: "s", exited: false }, { id: "agent", sessionId: "s", owned: true, exited: false }, { id: "dead", sessionId: "s", exited: true }];
    mocks.busy.mockResolvedValue(["shell"]);
    const { rerender } = render(<SessionRowData><SessionRowExtras sessions={[session]} selected={false} /></SessionRowData>);
    expect(await screen.findByRole("img", { name: "Running command" })).toBeTruthy();
    expect(mocks.busy).toHaveBeenCalledExactlyOnceWith(["shell"]);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("/repo");
    mocks.panes = [];
    rerender(<SessionRowData><SessionRowExtras sessions={[session]} selected={false} /></SessionRowData>);
    await waitFor(() => expect(screen.queryByRole("img", { name: "Running command" })).toBeNull());
  });
  it("shows a detached server's open port even without any shell panes", async () => {
    mocks.sessions = [session, { ...session, id: "archive", archived: true }, { ...session, id: "removed", worktreeRemoved: true }];
    mocks.ports.mockResolvedValue(["s"]);
    render(<SessionRowData><SessionRowExtras sessions={[session]} selected={false} /></SessionRowData>);
    expect(await screen.findByRole("img", { name: "Open port" })).toBeTruthy();
    expect(mocks.busy).not.toHaveBeenCalled();
    expect(mocks.ports).toHaveBeenCalledExactlyOnceWith([{ id: "s", cwd: "/repo/topic" }]);
  });
});
