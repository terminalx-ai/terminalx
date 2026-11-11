import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceRestorePreview } from "@/types/session";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), restore: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { previewWorkspaceRestore: mocks.preview }, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/lib/sessions", () => ({ restoreWorkspace: mocks.restore }));
import { closeWorkspaceRestore, openWorkspaceRestore } from "@/lib/dialogs";
import { WorkspaceRestoreDialog } from "./WorkspaceRestoreDialog";

const plan: WorkspaceRestorePreview = {
  projectPath: "/repo", path: "/repo/.raccoon/worktrees/topic", branch: "topic", commit: "a".repeat(40),
  needsBranch: null, suggestedBranch: "topic-restored", legacy: false, sessionIds: ["session", "sibling"],
};
const button = () => screen.getByRole("button", { name: "Restore workspace" }) as HTMLButtonElement;
const open = () => { render(<WorkspaceRestoreDialog />); act(() => openWorkspaceRestore("session")); };
beforeEach(() => {
  mocks.preview.mockReset().mockResolvedValue(plan);
  mocks.restore.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { act(closeWorkspaceRestore); cleanup(); });

it("waits for the check, explains archive-script files, and restores the existing branch only on confirmation", async () => {
  let finish!: (preview: WorkspaceRestorePreview) => void;
  mocks.preview.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  open();
  expect(button().disabled).toBe(true);
  expect(screen.getByText(/Git checkout can recreate tracked files deliberately removed by an archive script/)).toBeTruthy();
  await act(async () => finish(plan));
  expect(screen.getByText(plan.path)).toBeTruthy();
  expect(screen.getByText(plan.commit)).toBeTruthy();
  expect(screen.getByText("2 retained conversations will reopen here.")).toBeTruthy();
  expect(mocks.restore).not.toHaveBeenCalled();
  fireEvent.click(button());
  await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("session", plan, null));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it.each(["deleted", "moved", "checked out elsewhere", "detached HEAD"])("offers an editable new branch when the branch is %s", async (reason) => {
  const preview = { ...plan, needsBranch: `The branch is ${reason}.` };
  mocks.preview.mockResolvedValue(preview);
  open();
  const input = await screen.findByRole("textbox", { name: "New branch name" });
  expect((input as HTMLInputElement).value).toBe("topic-restored");
  expect(screen.getByText(preview.needsBranch)).toBeTruthy();
  fireEvent.change(input, { target: { value: " " } });
  expect(button().disabled).toBe(true);
  fireEvent.change(input, { target: { value: "review-fix" } });
  fireEvent.click(button());
  await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith("session", preview, "review-fix"));
});

it.each(["The workspace path is taken", "The recorded commit is missing"])("explains %s and creates nothing", async (error) => {
  mocks.preview.mockRejectedValue(new Error(error));
  open();
  expect((await screen.findByRole("alert")).textContent).toContain(error);
  expect(button().disabled).toBe(true);
  expect(mocks.restore).not.toHaveBeenCalled();
  mocks.preview.mockResolvedValue(plan);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(button().disabled).toBe(false));
});

it("keeps a failed restore open and requires a new check before retrying", async () => {
  mocks.restore.mockRejectedValue(new Error("The branch moved during restoration"));
  open();
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
  expect((await screen.findByRole("alert")).textContent).toContain("branch moved");
  expect(button().disabled).toBe(true);
  const changed = { ...plan, needsBranch: "The branch moved.", suggestedBranch: "topic-restored-2" };
  mocks.preview.mockResolvedValue(changed);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect((await screen.findByRole("textbox", { name: "New branch name" }) as HTMLInputElement).value).toBe("topic-restored-2");
});

it("does not dismiss or submit twice during restoration", async () => {
  let finish!: () => void;
  mocks.restore.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  open();
  await waitFor(() => expect(button().disabled).toBe(false));
  fireEvent.click(button());
  expect(button().disabled).toBe(true);
  fireEvent.click(button());
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(mocks.restore).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

it("warns when an older record can only recover the current branch tip", async () => {
  mocks.preview.mockResolvedValue({ ...plan, legacy: true });
  open();
  expect(await screen.findByText(/No removal commit was saved/)).toBeTruthy();
});

it("ignores a late preview after the dialog has changed sessions", async () => {
  let finish!: (preview: WorkspaceRestorePreview) => void;
  mocks.preview.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  open();
  act(() => openWorkspaceRestore("another"));
  await waitFor(() => expect(button().disabled).toBe(false));
  await act(async () => finish({ ...plan, path: "/stale-path" }));
  expect(screen.queryByText("/stale-path")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.restore).not.toHaveBeenCalled();
});
