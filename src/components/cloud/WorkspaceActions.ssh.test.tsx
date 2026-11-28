import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { WorkspaceActionItems } from "./WorkspaceActions";

const m = vi.hoisted(() => ({
  ready: false,
  privateMode: false,
  rows: [] as CloudWorkspaceListItem[],
  setup: vi.fn(),
  remove: vi.fn(),
  copy: vi.fn(),
  openEditor: vi.fn(),
  editorState: null as null | { phase: string },
}));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: {
  state: "signed-in", phase2Readiness: { org: m.ready ? ["cloud.workspaces.ssh.v1"] : [] },
} }) }));
vi.mock("@/lib/dataPrivacy", async (original) => ({
  ...(await original<typeof import("@/lib/dataPrivacy")>()),
  useDataPrivacy: () => ({ enabled: m.privateMode }),
}));
vi.mock("@/lib/cloudCatalog", async (original) => ({
  ...(await original<typeof import("@/lib/cloudCatalog")>()),
  useCloudCatalog: () => ({ orgs: { org: { source: "live", workspaces: m.rows } } }),
}));
vi.mock("@/lib/cloudWorkspaceDetails", async (original) => ({
  ...(await original<typeof import("@/lib/cloudWorkspaceDetails")>()),
  useWorkspaceDetailsAvailable: () => false,
}));
vi.mock("./WorkspaceFollowing", () => ({ useWorkspacePreferencesAvailable: () => false }));
vi.mock("@/lib/cloudSchedules", () => ({ useSchedulesOffer: () => "held" }));
vi.mock("@/components/cloud/CloudSchedulesDialog", () => ({ openSchedulesDialog: vi.fn() }));
vi.mock("@/components/cloud/CloudShareDialog", () => ({ openShareDialog: vi.fn() }));
vi.mock("@/lib/cloudSsh", () => ({
  setupWorkspaceSsh: m.setup, removeWorkspaceSsh: m.remove,
  SSH_EDITORS: [{ id: "vscode", label: "VS Code" }, { id: "cursor", label: "Cursor" }, { id: "zed", label: "Zed" }],
}));
vi.mock("@/components/cloud/CloudEditorOpen", () => ({
  openEditorDialog: m.openEditor,
  useEditorOpen: () => m.editorState,
  EditorButtonNote: ({ editor }: { editor: string }) => (editor === "zed" ? null : <span>Experimental</span>),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: m.copy }));
vi.mock("@/lib/platform", async (original) => ({ ...(await original<typeof import("@/lib/platform")>()), isWindows: false }));
vi.mock("@/components/ui/menu", () => ({
  DropdownMenuItem: ({ children, onSelect, disabled }: { children: React.ReactNode; onSelect?: () => void; disabled?: boolean }) =>
    <button disabled={disabled} onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
}));

const item = {
  workspace: { id: "ws", orgId: "org", name: "Docs", state: "ready", provider: "machine0",
    accessMode: "organization", you: { role: "driver", canApprove: true } },
  latestOperation: null,
} as unknown as CloudWorkspaceListItem;
const onLifecycle = vi.fn();
const run = (work: () => Promise<void>) => { void work(); };

beforeEach(() => {
  vi.clearAllMocks();
  m.ready = false;
  m.privateMode = false;
  m.rows = [item];
  m.setup.mockResolvedValue("ssh ws.terminalx");
  m.remove.mockResolvedValue(undefined);
  m.editorState = null;
});
afterEach(cleanup);

it("never calls SSH setup on render or when readiness changes", async () => {
  const view = render(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Set up SSH and copy command")).toBeNull();
  expect(screen.queryByText("Remove SSH setup")).toBeNull();
  m.ready = true;
  view.rerender(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect(m.setup).not.toHaveBeenCalled();
  expect(m.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Set up SSH and copy command"));
  expect(m.setup).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws" });
  await waitFor(() => expect(m.copy).toHaveBeenCalledWith("ssh ws.terminalx"));
  fireEvent.click(screen.getByText("Remove SSH setup"));
  expect(m.remove).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws" });
});

it("holds SSH in privacy mode and hides setup for viewers", () => {
  m.ready = true;
  m.privateMode = true;
  const view = render(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Set up SSH and copy command")).toBeNull();
  expect(screen.queryByText("Remove SSH setup")).toBeNull();
  m.privateMode = false;
  const viewer = { ...item, workspace: { ...item.workspace, you: { role: "viewer" as const, canApprove: false } } };
  m.rows = [viewer];
  view.rerender(<WorkspaceActionItems item={viewer} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Set up SSH and copy command")).toBeNull();
  expect(screen.getByText("Remove SSH setup")).toBeTruthy();
});

it("offers the editors to whoever may set up SSH, and opens one only on its own click", async () => {
  const view = render(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Open in VS Code")).toBeNull();
  m.ready = true;
  view.rerender(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect(["Open in VS Code", "Open in Cursor", "Open in Zed"].every((label) => screen.getByText(label))).toBe(true);
  // VS Code and Cursor need SSH forwarding, which is off: marked, still offered.
  expect(screen.getByText("Open in VS Code").textContent).toBe("Open in VS CodeExperimental");
  expect(screen.getByText("Open in Zed").textContent).toBe("Open in Zed");
  expect(m.openEditor).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Open in Zed"));
  expect(m.openEditor).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws", name: "Docs", preferredRepo: null }, "zed");
  // While an open runs, none starts again from the menu.
  m.editorState = { phase: "opening" };
  view.rerender(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect((screen.getByText("Open in Cursor") as HTMLButtonElement).disabled).toBe(true);
  m.editorState = null;

  const driver = { ...item, workspace: { ...item.workspace, you: { role: "driver" as const, canApprove: false } } };
  m.rows = [driver];
  view.rerender(<WorkspaceActionItems item={driver} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Open in VS Code")).toBeNull();
  const stopped = { ...item, workspace: { ...item.workspace, state: "suspended" } } as CloudWorkspaceListItem;
  m.rows = [stopped];
  view.rerender(<WorkspaceActionItems item={stopped} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Open in Cursor")).toBeNull();
  m.rows = [item];
  m.privateMode = true;
  view.rerender(<WorkspaceActionItems item={item} onLifecycle={onLifecycle} run={run} />);
  expect(screen.queryByText("Open in Zed")).toBeNull();
});
