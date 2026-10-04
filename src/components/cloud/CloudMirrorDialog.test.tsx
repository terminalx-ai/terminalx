import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudMirrorState } from "@/lib/cloudMirror";

const mocks = vi.hoisted(() => ({
  state: null as unknown as CloudMirrorState,
  loadCloudMirror: vi.fn(),
  setCloudMirrorEnabled: vi.fn(),
  resolveCloudMirror: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("@/lib/cloudMirror", () => ({
  useCloudMirror: () => mocks.state,
  loadCloudMirror: mocks.loadCloudMirror,
  setCloudMirrorEnabled: mocks.setCloudMirrorEnabled,
  resolveCloudMirror: mocks.resolveCloudMirror,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: mocks.openPath }));

const { CloudMirrorChip, CloudMirrorDialog } = await import("./CloudMirrorDialog");

const ROOT = "/Users/someone/.raccoon/cloud-mirrors/org-1/ws-1/files";
const base: CloudMirrorState = { phase: "off", root: ROOT, revision: null, progress: null, diverged: [], divergedTotal: 0, error: null, skipped: null };
const revision = { manifestId: "m1", atMs: Date.UTC(2026, 9, 3, 12, 0), files: 12, bytes: 3 * 1024 * 1024, repositories: [{ repo: ".", branch: "main", head: "abcdef1234567890" }] };
const request = { orgId: "org-1", workspaceId: "ws-1", workspaceName: "Fix login" };
const target = { orgId: "org-1", workspaceId: "ws-1" };

const show = (state: Partial<CloudMirrorState>) => {
  mocks.state = { ...base, ...state };
  return render(<CloudMirrorDialog request={request} onClose={() => {}} />);
};

beforeEach(() => {
  for (const mock of [mocks.loadCloudMirror, mocks.setCloudMirrorEnabled, mocks.resolveCloudMirror, mocks.openPath]) mock.mockReset();
  mocks.loadCloudMirror.mockResolvedValue(base);
  mocks.setCloudMirrorEnabled.mockResolvedValue(undefined);
  mocks.resolveCloudMirror.mockResolvedValue(null);
});
afterEach(cleanup);

describe("the local mirror dialog", () => {
  it("is off until the person turns it on, and says what it is and is not", async () => {
    show({ phase: "off" });
    const dialog = screen.getByTestId("cloud-mirror-dialog");
    expect(dialog.textContent).toContain("one way, from the workspace to here");
    expect(dialog.textContent).toContain("still run in the cloud workspace");
    expect(dialog.textContent).toContain("not a backup");
    expect(screen.getByTestId("cloud-mirror-state").textContent).toBe("Off");
    expect(mocks.setCloudMirrorEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn on for this computer" }));
    await waitFor(() => expect(mocks.setCloudMirrorEnabled).toHaveBeenCalledWith(target, true));
  });

  it("shows the last successful revision explicitly", () => {
    show({ phase: "synced", revision });
    expect(screen.getByTestId("cloud-mirror-state").textContent).toBe("Files synced");
    const shown = screen.getByTestId("cloud-mirror-revision").textContent ?? "";
    expect(shown).toContain("12 files");
    expect(shown).toContain("3.0 MB");
    expect(shown).toContain("main at abcdef1");
    expect(shown).toContain("uncommitted files");
    expect(screen.getByText(ROOT)).toBeTruthy();
  });

  it("keeps the last successful revision on screen while paused, failed or diverged", () => {
    for (const state of [
      { phase: "paused" as const },
      { phase: "failed" as const, error: "the connection closed" },
      { phase: "diverged" as const, diverged: [{ path: "a.ts", reason: "modified" as const }], divergedTotal: 1 },
    ]) {
      show({ ...state, revision });
      expect(screen.getByTestId("cloud-mirror-revision").textContent).toContain("12 files");
      cleanup();
    }
    show({ phase: "paused", revision });
    expect(screen.getByTestId("cloud-mirror-dialog").textContent).toContain("never starts a stopped workspace");
    cleanup();
    show({ phase: "failed", error: "the connection closed", revision });
    expect(screen.getByRole("alert").textContent).toBe("the connection closed");
  });

  it("resolves a divergence only by the person's choice", async () => {
    mocks.resolveCloudMirror.mockResolvedValue("/Users/someone/.raccoon/cloud-mirrors/org-1/ws-1/exports/1");
    show({
      phase: "diverged",
      revision,
      diverged: [{ path: "src/a.ts", reason: "modified" }, { path: "b.ts", reason: "deleted" }, { path: "c.ts", reason: "in-the-way" }],
      divergedTotal: 5,
    });
    const panel = screen.getByTestId("cloud-mirror-diverged");
    expect(panel.textContent).toContain("nothing here was overwritten or sent to the workspace");
    expect(panel.textContent).toContain("src/a.ts");
    expect(panel.textContent).toContain("edited here");
    expect(panel.textContent).toContain("deleted here");
    expect(panel.textContent).toContain("and 2 more");
    // Opening the dialog resolves nothing.
    expect(mocks.resolveCloudMirror).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep a copy, then use the workspace's files" }));
    await waitFor(() => expect(mocks.resolveCloudMirror).toHaveBeenCalledWith(target, "export"));
    await waitFor(() => expect(screen.getByTestId("cloud-mirror-exported").textContent).toContain("exports/1"));
    fireEvent.click(screen.getByRole("button", { name: "Discard my changes" }));
    await waitFor(() => expect(mocks.resolveCloudMirror).toHaveBeenCalledWith(target, "discard"));
  });

  it("turning off keeps the files; removing them is a separate, confirmed step", async () => {
    show({ phase: "synced", revision });
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(mocks.setCloudMirrorEnabled).toHaveBeenCalledWith(target, false));
    fireEvent.click(screen.getByRole("button", { name: "Remove local copy…" }));
    expect(mocks.setCloudMirrorEnabled).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove the local copy" }));
    await waitFor(() => expect(mocks.setCloudMirrorEnabled).toHaveBeenCalledWith(target, false, { removeFiles: true }));
  });

  it("says what was left out and why a runtime cannot be mirrored", () => {
    show({ phase: "synced", revision, skipped: { secret: 2, toolConfig: 3, gitDirectory: 5, collision: 1, tooLong: 0, invalid: 1, excluded: 0, symlink: 1, unsupported: 1, tooLarge: 0 } });
    const text = screen.getByTestId("cloud-mirror-dialog").textContent ?? "";
    expect(text).toContain("Not mirrored: 2 secret files, 3 tool settings that run commands (agent, editor and Git hook configuration), 5 inside a folder Git would treat as a repository");
    expect(text).toContain("1 whose name is taken by another file on this disk, 1 link, 2 other.");
    // The dialog says what the copy is, and when it goes away.
    expect(text).toContain("treat them like a download");
    // What it does not promise: macOS asks, it does not prevent; a tool opened there may run code.
    expect(text).toContain("No file in the copy is marked executable, and macOS asks before opening one");
    expect(text).toContain("may still build or index it, which runs the workspace's code on this computer");
    expect(text).not.toContain("Nothing in the copy can be run");
    expect(text).toContain("files you edited in it are kept aside");
    expect(text).toContain("cannot be opened as a project or used by an agent here");
    expect(text).toContain("removed from this computer if you lose access to the workspace, sign out, or the workspace is deleted");
    cleanup();
    show({ phase: "unsupported" });
    expect(screen.getByTestId("cloud-mirror-state").textContent).toContain("too old for a mirror");
  });
});

describe("the mirror chip in the session header", () => {
  it("is absent while the mirror is off and speaks only of files otherwise", () => {
    mocks.state = { ...base, phase: "off" };
    const { container } = render(<CloudMirrorChip orgId="org-1" workspaceId="ws-1" onOpen={() => {}} />);
    expect(container.textContent).toBe("");
    cleanup();
    mocks.state = { ...base, phase: "synced", revision };
    render(<CloudMirrorChip orgId="org-1" workspaceId="ws-1" onOpen={() => {}} />);
    const chip = screen.getByTestId("cloud-mirror-chip");
    expect(chip.textContent).toBe("Files mirrored");
    expect(chip.getAttribute("title")).toContain("A copy of files only");
    expect(chip.getAttribute("title")).toContain("not a backup");
    // No wording that would suggest local execution or a backup.
    expect(`${chip.textContent} ${chip.getAttribute("title")}`).not.toMatch(/backed up|runs? (here|locally)|local workspace/i);
    cleanup();
    mocks.state = { ...base, phase: "diverged", divergedTotal: 2 };
    render(<CloudMirrorChip orgId="org-1" workspaceId="ws-1" onOpen={() => {}} />);
    expect(screen.getByTestId("cloud-mirror-chip").textContent).toBe("Mirror: local changes");
  });
});
