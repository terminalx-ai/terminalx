import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudWorkspaceItem } from "../../api";
import type { CloudCatalog } from "../../catalog";
import { workspaceRowActions } from "./actions";
import { cleanupFacts, deletionRefusal } from "./cleanup";

const alert = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Alert: { alert }, Platform: { OS: "ios" }, StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 } }));

type Button = { text: string; style?: string; onPress?: () => void };
const last = () => alert.mock.calls.at(-1) as [string, string | undefined, Button[]];
const press = async (label: string) => { last()[2].find((entry) => entry.text === label)!.onPress?.(); await new Promise((resolve) => setTimeout(resolve, 0)); };

const row = (state: string, role: string, fields: Record<string, unknown> = {}, latestOperation: Record<string, unknown> | null = null) =>
  ({ workspace: { id: "ws-1", orgId: "org-1", name: "Checkout redesign", provider: "box", state, you: { role, canApprove: true }, ...fields }, latestOperation }) as unknown as CloudWorkspaceItem;

function catalog(providers: () => Promise<unknown[]> = async () => [{ id: "box", descriptor: { label: "Boat", billing: "Per second, billed by Boat." } }]) {
  return {
    api: { providers: vi.fn(providers), suspend: vi.fn(async () => ({ workspace: {}, operation: { id: "op-stop", state: "running" } })) },
    start: vi.fn(async () => "started"),
    refresh: vi.fn(async () => undefined),
  } as unknown as CloudCatalog & { api: { suspend: ReturnType<typeof vi.fn> }; refresh: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
}

beforeEach(() => alert.mockClear());

describe("a workspace's actions for a long press and the header's •••", () => {
  it("are nothing for someone who may not manage it", () => {
    for (const role of ["driver", "viewer", "none"]) expect(workspaceRowActions(row("ready", role), { catalog: catalog(), push: vi.fn() })).toEqual([]);
    expect(workspaceRowActions({ ...row("ready", "manager"), workspace: { ...row("ready", "manager").workspace, you: null } }, { catalog: catalog(), push: vi.fn() })).toEqual([]);
  });

  it("are Stop workspace and Delete workspace… while it runs, Start workspace and Delete workspace… while it is stopped, in the row actions' shape", () => {
    const push = vi.fn();
    const running = workspaceRowActions(row("ready", "manager"), { catalog: catalog(), push });
    expect(running.map(({ name, label, destructive }) => ({ name, label, destructive }))).toEqual([
      { name: "stop-workspace", label: "Stop workspace", destructive: undefined },
      { name: "delete-workspace", label: "Delete workspace…", destructive: true },
    ]);
    expect(workspaceRowActions(row("suspended", "manager"), { catalog: catalog(), push }).map((action) => action.label)).toEqual(["Start workspace", "Delete workspace…"]);
    // Being stopped or deleted already: not offered again.
    expect(workspaceRowActions(row("ready", "manager", {}, { id: "op", state: "running", action: "suspend" }), { catalog: catalog(), push }).map((action) => action.label)).toEqual(["Delete workspace…"]);
    expect(workspaceRowActions(row("deleting", "manager"), { catalog: catalog(), push })).toEqual([]);
    // Delete opens its page; it does not act.
    running[1]!.run();
    expect(push).toHaveBeenCalledWith("/cloud/delete?orgId=org-1&workspaceId=ws-1");
  });

  it("asks before stopping from the list, quoting the provider's billing line, and says an agent is working from the list's activity", async () => {
    const made = catalog();
    const [stop] = workspaceRowActions(row("ready", "manager", { runtimeActivity: { activeTurns: 1 } }), { catalog: made, push: vi.fn() });
    stop!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(last()[0]).toBe("Stop while an agent is working?");
    expect(last()[1]).toBe("An agent is in the middle of a turn. Stopping interrupts it; what it has not saved may be lost. Boat: per second, billed by Boat.");
    expect(made.api.suspend).not.toHaveBeenCalled();
    await press("Stop anyway");
    expect(made.api.suspend).toHaveBeenCalledWith("org-1", "ws-1");
    expect(made.refresh).toHaveBeenCalled();
  });

  it("still asks when the provider's words cannot be read, and claims nothing about cost then", async () => {
    const made = catalog(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
    workspaceRowActions(row("ready", "manager"), { catalog: made, push: vi.fn() })[0]!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(last()[0]).toBe("Stop this workspace?");
    expect(last()[1]).toBe("Its agents stop until it is started again.");
  });

  it("says a refused stop in words, never as a code", async () => {
    const made = catalog();
    made.api.suspend.mockImplementation(async () => { throw new CloudApiError("cloud_workspace_manager_required", 403); });
    workspaceRowActions(row("ready", "manager"), { catalog: made, push: vi.fn() })[0]!.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await press("Stop");
    expect(last()[0]).toBe("The workspace was not stopped");
    expect(last()[1]).toBe("Only this workspace's creator or an organization owner or admin can do that.");
  });

  it("starts a stopped one only after the person confirms", async () => {
    const made = catalog();
    workspaceRowActions(row("suspended", "manager"), { catalog: made, push: vi.fn() })[0]!.run();
    expect(last()[0]).toBe("Start this workspace?");
    expect(made.start).not.toHaveBeenCalled();
    await press("Start");
    expect(made.start).toHaveBeenCalledWith("org-1", "ws-1");
  });
});

describe("a delete the provider did not confirm", () => {
  it("is said in the console's sentence with the provider's name, and its cleanup report in plain words", () => {
    expect(deletionRefusal({ errorCode: "cloud_provider_permission_denied", providerErrorCode: "403" }, "Boat")).toBe("Boat refused to delete this machine (403). Check it in your Boat dashboard; if it is still there, delete it there, then press Delete again to clear it here.");
    expect(deletionRefusal({ errorCode: "cloud_provider_unavailable" }, "Boat")).toBe("Boat did not confirm the removal. Check it in your Boat dashboard; if it is still there, delete it there, then press Delete again to clear it here.");
    expect(cleanupFacts({ cleanup: { complete: false, items: [{ kind: "client-attachments", state: "removed" }, { kind: "provider-compute", state: "retained-by-provider" }, { kind: "workspace-content", state: "pending" }, { kind: "something-new", state: "removed" }] } })).toEqual([
      { label: "Phones and desktops", value: "Disconnected", tone: "success" },
      { label: "Machine", value: "Not confirmed", tone: "danger" },
      { label: "Saved conversations", value: "Pending", tone: "warning" },
    ]);
  });
});
