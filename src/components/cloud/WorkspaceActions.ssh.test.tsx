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
vi.mock("@/lib/cloudSsh", () => ({ setupWorkspaceSsh: m.setup, removeWorkspaceSsh: m.remove }));
vi.mock("@/lib/clipboard", () => ({ copyText: m.copy }));
vi.mock("@/lib/platform", async (original) => ({ ...(await original<typeof import("@/lib/platform")>()), isWindows: false }));
vi.mock("@/components/ui/menu", () => ({
  DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
    <button onClick={onSelect}>{children}</button>,
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
