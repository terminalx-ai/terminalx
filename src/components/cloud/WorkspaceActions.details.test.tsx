import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
const m = vi.hoisted(() => ({ ready: false, restart: vi.fn(), resume: vi.fn(), scope: "account-a", reconnects: vi.fn(), connection: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<any>()), workspaceConnection: m.connection, hasWorkspaceConnection: () => true }));
vi.mock("@/lib/errorToasts", async (original) => ({ ...(await original<typeof import("@/lib/errorToasts")>()), showError: m.toast }));
vi.mock("@/lib/cloudWorkspaceDetails", async (original) => ({
  ...(await original<typeof import("@/lib/cloudWorkspaceDetails")>()),
  useWorkspaceDetailsAvailable: () => m.ready,
  detailsScope: () => m.scope,
  canRestartWorkspace: (item: any) => item.workspace.you?.role === "manager" && item.workspace.state === "ready" && !item.latestOperation,
  restartCloudWorkspace: m.restart,
}));
vi.mock("@/components/cloud/CloudWorkspaceDetails", () => ({
  CloudWorkspaceDetailsCard: ({ initialCopy, onInitialCopy }: { initialCopy?: string; onInitialCopy: (message: string) => void }) =>
    <><div>Details {initialCopy}</div><button onClick={() => onInitialCopy("Copied machine ID")}>Finish copy</button></>,
}));
vi.mock("@/components/ui/menu", () => ({ DropdownMenuItem: ({ children, onSelect, disabled }: any) => <button disabled={disabled} onClick={onSelect}>{children}</button>, DropdownMenuSeparator: () => <hr /> }));
vi.mock("@/lib/cloudSchedules", () => ({ useSchedulesOffer: () => "offered" }));
vi.mock("@/components/cloud/CloudSchedulesDialog", () => ({ openSchedulesDialog: vi.fn() }));
vi.mock("@/components/cloud/CloudShareDialog", () => ({ openShareDialog: vi.fn() }));
vi.mock("@/lib/cloudCatalog", async (original) => ({ ...(await original<any>()), resumeCloudWorkspace: m.resume }));
import { RestartAlreadyPendingError, RestartOperationError } from "@/lib/cloudWorkspaceDetails";
import { WorkspaceActionItems, WorkspaceLifecycleDialog } from "./WorkspaceActions";
const item = { workspace: { id: "ws", orgId: "org", name: "Docs", state: "ready", accessMode: "organization", provider: "machine0", you: { role: "manager", canApprove: true } }, latestOperation: null } as unknown as CloudWorkspaceListItem;
beforeEach(() => { vi.clearAllMocks(); m.ready = true; m.scope = "account-a"; });
afterEach(cleanup);
it("holds production restart/details/copy menu actions without disturbing existing lifecycle/share", () => {
  m.ready = false; render(<WorkspaceActionItems item={item} onLifecycle={() => {}} run={() => {}} />);
  expect(screen.queryByText("Restart workspace…")).toBeNull(); expect(screen.queryByText("Copy machine ID")).toBeNull();
  expect(screen.queryByText("Open provisioning log")).toBeNull();
  expect(screen.getByText("Stop")).toBeTruthy(); expect(screen.getByText("Share…")).toBeTruthy();
});
it("offers metadata and copy through the external dialog owner, and keeps restart behind management authority", () => {
  const select = vi.fn();
  const view = render(<WorkspaceActionItems item={item} onLifecycle={select} run={() => {}} />);
  fireEvent.click(screen.getByText("Copy machine ID")); expect(select).toHaveBeenLastCalledWith({ item, action: "copy-machine" });
  fireEvent.click(screen.getByText("Copy workspace info")); expect(select).toHaveBeenLastCalledWith({ item, action: "copy-info" });
  fireEvent.click(screen.getByText("Restart workspace…")); expect(select).toHaveBeenLastCalledWith({ item, action: "restart" });
  const viewer = { ...item, workspace: { ...item.workspace, you: { role: "viewer", canApprove: false } } } as CloudWorkspaceListItem;
  view.rerender(<WorkspaceActionItems item={viewer} onLifecycle={select} run={() => {}} />);
  expect(screen.queryByText("Restart workspace…")).toBeNull(); expect(screen.getByText("Workspace details…")).toBeTruthy();
  expect(screen.queryByText("Open provisioning log")).toBeNull();
});
it("requires confirmation and stays pending until the restart operation completes", async () => {
  let finish!: () => void;
  m.restart.mockImplementation(() => new Promise<void>((done) => { finish = done; }));
  const close = vi.fn(); render(<WorkspaceLifecycleDialog request={{ item, action: "restart" }} onClose={close} />);
  const button = screen.getByRole("button", { name: "Restart workspace" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); expect(m.restart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
  expect(m.restart).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("Restart pending"); expect(close).not.toHaveBeenCalled();
  await act(async () => { finish(); }); expect(close).toHaveBeenCalledTimes(1);
  expect(m.toast).toHaveBeenCalledWith("Docs", undefined, expect.objectContaining({ title: "Restarted workspace", tone: "success" }));
});
it.each(["success", "failure"])("can dismiss a pending restart and still receive its %s toast", async (outcome) => {
  let settle!: () => void;
  m.restart.mockImplementation(() => new Promise<void>((resolve, reject) => {
    settle = outcome === "success" ? resolve : () => reject(new RestartOperationError("Restart failed."));
  }));
  const close = vi.fn();
  const view = render(<WorkspaceLifecycleDialog request={{ item, action: "restart" }} onClose={() => { close(); view.unmount(); }} />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Restart workspace" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(m.toast).not.toHaveBeenCalled();
  await act(async () => settle());
  expect(close).toHaveBeenCalledTimes(1);
  expect(m.toast).toHaveBeenCalledWith("Docs", outcome === "success" ? undefined : "Restart failed.",
    expect.objectContaining({ tone: outcome === "success" ? "success" : "error" }));
});
it("shows restart refusal and permits an explicit retry without force or wake", async () => {
  m.restart.mockRejectedValue(new Error("Running work prevents this restart."));
  render(<WorkspaceLifecycleDialog request={{ item, action: "restart" }} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Restart workspace" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Running work prevents this restart.");
  expect(m.restart).toHaveBeenCalledExactlyOnceWith(item); expect(m.resume).not.toHaveBeenCalled();
  expect(m.toast).toHaveBeenCalledWith("Docs", "Running work prevents this restart.", expect.objectContaining({ title: "Couldn't restart workspace" }));
  expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", false);
});
it("reports a terminal failure and leaves recovery to the workspace", async () => {
  m.restart.mockRejectedValue(new RestartOperationError("The operation failed."));
  const close = vi.fn();
  render(<WorkspaceLifecycleDialog request={{ item, action: "restart" }} onClose={close} />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Restart workspace" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(m.toast).toHaveBeenCalledWith("Docs", "The operation failed.", expect.objectContaining({
    title: "Couldn't restart workspace",
    actions: [expect.objectContaining({ label: "Open workspace" })],
  }));
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(m.resume).not.toHaveBeenCalled();
});

it("routes copy selection into the details card fallback surface", () => {
  render(<WorkspaceLifecycleDialog request={{ item, action: "copy-info" }} onClose={() => {}} />);
  expect(screen.getByText("Details info")).toBeTruthy();
});

it("closes a successful menu copy and announces the copied field", () => {
  const close = vi.fn();
  render(<WorkspaceLifecycleDialog request={{ item, action: "copy-machine" }} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Finish copy" }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(m.toast).toHaveBeenCalledWith("", undefined, expect.objectContaining({ title: "Copied machine ID", tone: "success" }));
});

it("holds direct restart and copy dialogs without readiness", () => {
  m.ready = false;
  const view = render(<WorkspaceLifecycleDialog request={{ item, action: "restart" }} onClose={() => {}} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<WorkspaceLifecycleDialog request={{ item, action: "copy-info" }} onClose={() => {}} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(m.restart).not.toHaveBeenCalled();
});

it("does not invite another restart when a restart is already being tracked", async () => {
  m.restart.mockRejectedValue(new RestartAlreadyPendingError());
  render(<WorkspaceLifecycleDialog request={{ item, action: "restart" }} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Restart workspace" }));
  expect(await screen.findByText("A restart is already pending.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByRole("button", { name: "Restart workspace" })).toHaveProperty("disabled", true);
});

it("reattaches held leases after restart using connect without waking compute", async () => {
  const { retainCloudConnection, reconnectCloudWorkspace, resetCloudConnections } = await import("@/lib/cloudConnections");
  resetCloudConnections();
  const close = vi.fn();
  const client = () => ({ onState: (listener: (state: unknown) => void) => {
    listener({ state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage" });
    return () => {};
  } });
  m.connection.mockImplementation(async () => ({ client: client(), activate: vi.fn(async () => {}), close }));
  const lease = await retainCloudConnection({ orgId: "org", workspaceId: "ws" }, "connect");
  const previous = lease.current();
  reconnectCloudWorkspace({ orgId: "org", workspaceId: "ws" });
  await act(async () => { await Promise.resolve(); });
  expect(close).toHaveBeenCalledTimes(1);
  expect(lease.ended()).toBe(false);
  expect(lease.current()).not.toBe(previous);
  expect(m.connection).toHaveBeenCalledTimes(2);
  for (const call of m.connection.mock.calls) expect(call[1]).toBe("connect");
  lease.release(); resetCloudConnections();
});

it("hides details/restart/copy for a locked session while preserving existing lifecycle actions", () => {
  render(<WorkspaceActionItems item={item} detailsAllowed={false} onLifecycle={() => {}} run={() => {}} />);
  expect(screen.queryByText("Workspace details…")).toBeNull();
  expect(screen.queryByText("Restart workspace…")).toBeNull();
  expect(screen.queryByText("Copy workspace info")).toBeNull();
  expect(screen.getByText("Stop")).toBeTruthy();
});
