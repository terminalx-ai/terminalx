import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMirrorStatus } from "@/lib/api";
import type { SessionEntry } from "@/types/session";

const backend = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { repoMirrorStatus: backend.status, repoMirrorStart: backend.start, repoMirrorStop: backend.stop },
  errorMessage: (error: unknown) => String(error),
}));
import { RepoMirrorControl } from "./RepoMirrorControl";

const session = { id: "local-session", projectPath: "/repo", cwd: "/repo/worktree", worktreeName: "feature", worktreeRemoved: false } as SessionEntry;
const off: RepoMirrorStatus = { root: "/repo", source: null, active: false, error: null };
const on: RepoMirrorStatus = { ...off, source: session.cwd, active: true };

beforeEach(() => {
  vi.clearAllMocks();
  backend.status.mockResolvedValue(off);
  backend.start.mockResolvedValue(on);
  backend.stop.mockResolvedValue(off);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("repository root mirroring", () => {
  it("names both paths and waits for explicit confirmation before starting", async () => {
    render(<RepoMirrorControl session={session} />);
    await waitFor(() => expect(backend.status).toHaveBeenCalledWith(session.id));
    fireEvent.click(screen.getByRole("button", { name: "Mirror into repo root" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("/repo")).toBeTruthy();
    expect(within(dialog).getByText(session.cwd)).toBeTruthy();
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(backend.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mirror into repo root" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mirror into repo root" }));
    await waitFor(() => expect(backend.start).toHaveBeenCalledWith(session.id, true));
    expect(await screen.findByRole("button", { name: "Mirroring to repo root" })).toBeTruthy();
  });

  it("shows dirty-root refusal and keeps the confirmation open", async () => {
    backend.start.mockRejectedValue("The repository root has uncommitted changes: file.txt");
    render(<RepoMirrorControl session={session} />);
    fireEvent.click(screen.getByRole("button", { name: "Mirror into repo root" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Mirror into repo root" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Mirror into repo root" }));
    expect((await screen.findByRole("alert")).textContent).toContain("uncommitted changes: file.txt");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("offers recovery from the root session after restart or workspace removal", async () => {
    backend.status.mockResolvedValue({ ...on, active: false, error: "Mirroring was interrupted" });
    render(<RepoMirrorControl session={{ ...session, cwd: "/repo", worktreeRemoved: true, worktreeName: null }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Repo root mirror paused" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(session.cwd)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop mirroring" }));
    await waitFor(() => expect(backend.stop).toHaveBeenCalledWith(session.id));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.start).not.toHaveBeenCalled();
  });

  it("keeps stop errors visible and allows retry without starting again", async () => {
    backend.status.mockResolvedValue(on);
    backend.stop.mockRejectedValueOnce("The repository root was edited outside mirroring");
    render(<RepoMirrorControl session={session} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mirroring to repo root" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop mirroring" }));
    expect((await screen.findByRole("alert")).textContent).toContain("edited outside");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop mirroring" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.stop).toHaveBeenCalledTimes(2);
  });

  it("does not offer start for quick chats or the main checkout", async () => {
    const { rerender } = render(<RepoMirrorControl session={{ ...session, worktreeName: null }} />);
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<RepoMirrorControl session={{ ...session, kind: "quick" }} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("polls paused status without initiating sync or duplicate mutations", async () => {
    vi.useFakeTimers();
    backend.status.mockResolvedValueOnce(on).mockResolvedValue({ ...on, active: false, error: "Root changed" });
    render(<RepoMirrorControl session={session} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Mirroring to repo root" })).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByRole("button", { name: "Repo root mirror paused" })).toBeTruthy();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.stop).not.toHaveBeenCalled();
  });
});
