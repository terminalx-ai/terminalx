import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDisposition } from "@/types/session";
const mocks = vi.hoisted(() => ({ check: vi.fn(), remove: vi.fn(), session: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { workspaceDisposition: mocks.check }, errorMessage: String }));
vi.mock("@/lib/sessions", () => ({ deleteWorkspace: mocks.remove, deleteSession: mocks.session, settleSession: mocks.settle }));
vi.mock("@/lib/worktreeConfirm", () => ({ reportBranchOutcome: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
import { WorkspaceRemovalDialog } from "./WorkspaceDeleteDialog";
const clean: WorkspaceDisposition = {
  exists: true, checked: true, isMain: false, branch: "feature", uncommitted: 0, unpushed: 0,
  aheadOfBase: 0, prChecked: false, sessions: 2, sessionTitles: ["Fix login", "Review login"],
  defaultBranch: "main", merged: true, pushed: true, stashes: 0, safe: true, verificationError: null, pr: null,
};
function mount(intent: "delete" | "settle" | "session" = "delete") {
  return render(<WorkspaceRemovalDialog projectPath="/p" path="/p/wt" name="feature" sessionId={intent === "delete" ? undefined : "s1"} intent={intent} onClose={vi.fn()} />);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.check.mockResolvedValue(clean);
  mocks.remove.mockResolvedValue({});
  mocks.session.mockResolvedValue({});
  mocks.settle.mockResolvedValue({});
});
afterEach(cleanup);

describe("shared workspace removal", () => {
  it("names all sessions and deletes a clean merged workspace with one confirmation", async () => {
    mount();
    await screen.findByText("Merged and clean: safe to delete.");
    expect(screen.getByText("Fix login")).toBeTruthy();
    expect(screen.getByText("Review login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("/p", "/p/wt", true, false));
    expect(screen.queryByText("Confirm permanent removal")).toBeNull();
  });

  it.each([
    { label: "dirty", patch: { uncommitted: 2, safe: false }, detail: "2 uncommitted or untracked files will be lost." },
    { label: "pushed but unmerged", patch: { merged: false, aheadOfBase: 3, safe: false }, detail: "3 commits not in main." },
    { label: "stashed", patch: { stashes: 1, safe: false }, detail: /1 repository stash entries/ },
    { label: "unverified", patch: { merged: null, verificationError: "Cannot fetch origin", safe: false }, detail: "Not verified: Cannot fetch origin" },
  ])("requires a second explicit confirmation when $label", async ({ patch, detail }) => {
    mocks.check.mockResolvedValue({ ...clean, ...patch });
    mount();
    await screen.findByText(detail);
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm permanent removal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("/p", "/p/wt", true, true));
  });

  it("deletes only one session in a shared workspace", async () => {
    mount("session");
    await screen.findByText("Other sessions use this workspace. It will remain on disk.");
    expect(screen.queryByRole("switch", { name: "Also delete the workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    await waitFor(() => expect(mocks.session).toHaveBeenCalledWith("s1", false, false));
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("offers explicit workspace removal for the last session, off by default", async () => {
    mocks.check.mockResolvedValue({ ...clean, sessions: 1, sessionTitles: ["Fix login"], safe: false, merged: false });
    mount("session");
    const choice = await screen.findByRole("switch", { name: "Also delete the workspace" });
    expect(choice.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Delete session and workspace" }));
    expect(mocks.session).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(mocks.session).toHaveBeenCalledWith("s1", true, true));
  });

  it("settles through the same warning while retaining every conversation", async () => {
    mocks.check.mockResolvedValue({ ...clean, safe: false, uncommitted: 1 });
    mount("settle");
    await screen.findByText("2 sessions will be kept at the project root:");
    fireEvent.click(screen.getByRole("button", { name: "Settle and delete workspace" }));
    expect(mocks.settle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(mocks.settle).toHaveBeenCalledWith("s1", "delete", true));
  });

  it("refreshes the check and clears the acknowledgement after a removal failure", async () => {
    mocks.remove.mockRejectedValueOnce(new Error("workspace changed"));
    mocks.check.mockResolvedValueOnce(clean).mockResolvedValueOnce({ ...clean, safe: false, uncommitted: 4 });
    mount();
    await screen.findByText("Merged and clean: safe to delete.");
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    await screen.findByText("4 uncommitted or untracked files will be lost.");
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete anyway" })));
    expect(mocks.remove).toHaveBeenCalledTimes(2);
  });
});
