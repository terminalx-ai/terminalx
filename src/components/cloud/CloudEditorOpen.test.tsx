import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/cloudSsh", () => ({
  openWorkspaceInEditor: m.open,
  SSH_EDITORS: [
    { id: "vscode", label: "VS Code", needsForwarding: true },
    { id: "cursor", label: "Cursor", needsForwarding: true },
    { id: "zed", label: "Zed", needsForwarding: false },
  ],
}));

const { CloudEditorOpenHost, openEditorDialog } = await import("./CloudEditorOpen");
afterEach(() => { act(() => openEditorDialog(null)); cleanup(); });

it("shows the setup's progress, blocks a second open, then says plainly what went wrong", async () => {
  let fail!: (reason: unknown) => void;
  m.open.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  render(<CloudEditorOpenHost />);
  act(() => openEditorDialog({ orgId: "org", workspaceId: "ws", name: "Docs", preferredRepo: "widgets" }, "vscode"));
  expect(screen.getByText("Open Docs in an editor")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/^Setting up SSH and opening VS Code… This can take up to half a minute\.$/);
  expect(screen.getByText("Opening VS Code…")).toBeTruthy();
  expect(screen.getByText("VS Code and Cursor may not connect yet: they need SSH forwarding, which is off.")).toBeTruthy();
  const zed = screen.getByRole("button", { name: "Zed" }) as HTMLButtonElement;
  expect(zed.disabled).toBe(true);
  expect(m.open).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws" }, "vscode", undefined, "widgets");
  await act(async () => fail("VS Code is not installed"));
  expect(screen.getByRole("alert").textContent).toBe("VS Code is not installed");

  m.open.mockResolvedValueOnce(undefined);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Zed" })));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Opened in Zed.");
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText("Open Docs in an editor")).toBeNull();
});

it("shows an opener's own failure as its message, not an object", async () => {
  m.open.mockRejectedValueOnce(new Error("Cursor did not open: launch failed"));
  render(<CloudEditorOpenHost />);
  await act(async () => openEditorDialog({ orgId: "org", workspaceId: "ws2", name: "Docs" }, "cursor"));
  expect(screen.getByRole("alert").textContent).toBe("Cursor did not open: launch failed");
});
