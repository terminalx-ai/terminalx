import { describe, expect, it } from "vitest";
import type { CloudOperation, CloudWorkspaceItem } from "../../api";
import { launchView, leftAtProvider, listedLaunch, operationOpen, stageIndex } from "./launch";
import { billingLine, diskLine, launchCause } from "./sentences";

const op = (fields: Partial<CloudOperation> = {}): CloudOperation => ({ id: "op-1", workspaceId: "ws-1", type: "create", state: "running", stage: "queued", cancelable: true, createdAt: 1, updatedAt: 2, ...fields });
const listItem = (state: string, latestOperation: Record<string, unknown> | null) => ({ workspace: { id: "ws-1", orgId: "org-1", name: "Checkout redesign", provider: "box", state }, latestOperation }) as unknown as CloudWorkspaceItem;

describe("which operation is a launch the page shows", () => {
  it("is a create with no later action, while it runs, or once it failed or was canceled without the workspace running", () => {
    expect(listedLaunch(listItem("provisioning", { id: "op-1", state: "running", type: "create", action: null }))?.id).toBe("op-1");
    expect(listedLaunch(listItem("attention-required", { id: "op-1", state: "failed", type: "create", action: null }))?.id).toBe("op-1");
    expect(listedLaunch(listItem("destroyed", { id: "op-1", state: "canceled", type: "create" }))?.id).toBe("op-1");
    // A stop, a start or a delete is not a launch, and a launch that ran through is the workspace page as today.
    expect(listedLaunch(listItem("suspending", { id: "op-2", state: "running", type: "create", action: "suspend" }))).toBeNull();
    expect(listedLaunch(listItem("ready", { id: "op-1", state: "succeeded", type: "create", action: null }))).toBeNull();
    expect(listedLaunch(listItem("ready", { id: "op-1", state: "failed", type: "create", action: null }))).toBeNull();
    expect(listedLaunch(listItem("ready", null))).toBeNull();
    expect(operationOpen({ state: "cancel-requested" })).toBe(true);
    expect(operationOpen({ state: "failed" })).toBe(false);
  });
});

describe("how far a launch is", () => {
  it("reads its stage, and while it cleans up the furthest stage its events name", () => {
    expect(stageIndex(op({ stage: "creating-machine" }))).toBe(2);
    expect(stageIndex(op({ stage: "ready" }))).toBe(5);
    expect(stageIndex(op({ stage: "cleanup", events: [{ code: "provider-preflight-started", occurredAt: 1 }, { code: "repository-cloning", occurredAt: 3 }, { code: "provider-cleanup-started", occurredAt: 4 }] }))).toBe(3);
    expect(stageIndex(op({ stage: null }))).toBe(0);
  });

  it("shows the newest event of the stage under way, and Cancel only while the server says it can be canceled", () => {
    const view = launchView(op({ stage: "bootstrapping", cancelable: false, events: [{ code: "credentials-installing", occurredAt: 1 }, { code: "repository-cloning", occurredAt: 2 }] }), { name: "Checkout redesign" }, "Boat");
    expect(view).toMatchObject({ phase: "running", title: "Launching…", current: 3, status: "running", detail: "Cloning the repository", cancelable: false, note: { text: "It can no longer be canceled. Once it is running you can stop or delete it.", tone: "plain" } });
    expect(launchView(op(), { name: "x" }, "Boat").note?.text).toBe("You can leave this page. The launch carries on, and the workspace shows in the Cloud tab.");
  });

  it("says it is running once it succeeded", () => {
    expect(launchView(op({ state: "succeeded", stage: "ready", cancelable: false }), { name: "Checkout redesign" }, "Boat")).toMatchObject({ phase: "finished", title: "Checkout redesign is running", status: "finished", note: { text: "Opening it in a moment…" } });
  });
});

describe("a launch that did not finish", () => {
  it("says what it left at the provider from the cleanup report, since that may cost money", () => {
    expect(leftAtProvider(op({ state: "canceled", cleanup: { complete: true, items: [{ kind: "provider-compute", state: "removed" }] } }), "Boat")).toEqual({ text: "The machine was removed.", costs: false });
    expect(leftAtProvider(op({ state: "failed", stage: "bootstrapping", reason: "attention-stopped" }), "Boat")).toEqual({ text: "The machine exists and was stopped to avoid charges after a problem.", costs: true });
    expect(leftAtProvider(op({ state: "failed", stage: "preflight" }), "Boat")).toEqual({ text: "No machine was created.", costs: false });
    expect(leftAtProvider(op({ state: "failed", stage: "creating-machine", cleanup: { complete: false, items: [{ kind: "provider-compute", state: "unconfirmed" }] } }), "Boat")).toEqual({ text: "Check Boat’s dashboard if a machine is still listed there.", costs: true });
  });

  it("gives each cause the board's sentence, and never a raw code", () => {
    expect(launchCause("cloud_workspace_runtime_bootstrap_failed")).toEqual({ kind: "runtime", text: "Installing or starting the runtime on the machine failed." });
    expect(launchCause("cloud_provider_credential_invalid")).toEqual({ kind: "key", text: "The provider rejected the API key." });
    expect(launchCause("cloud_workspace_provisioning_timeout")).toEqual({ kind: "timeout", text: "The workspace’s machine took too long to start." });
    expect(launchCause("cloud_provider_unavailable")).toEqual({ kind: "other", text: "The cloud provider is not answering right now." });
    expect(launchCause("cloud_brand_new_failure")).toEqual({ kind: "other", text: "The launch did not finish." });
    expect(launchCause(undefined).text).toBe("The launch did not finish.");
  });

  it("puts the cause under the stage it stopped at, and what to do next after what was left", () => {
    expect(launchView(op({ state: "canceled", stage: "cleanup", events: [{ code: "machine-allocation-started", occurredAt: 1 }], cleanup: { complete: true, items: [{ kind: "provider-compute", state: "removed" }] } }), { name: "x" }, "Boat"))
      .toMatchObject({ phase: "canceled", title: "Launch canceled", current: 2, status: "failed", detail: "Canceled", failure: "canceled", note: { text: "The machine was removed. Launching again asks for a new price.", tone: "plain" } });
    expect(launchView(op({ state: "failed", stage: "bootstrapping", errorCode: "cloud_workspace_runtime_bootstrap_failed", reason: "attention-stopped" }), { name: "x" }, "Boat"))
      .toMatchObject({ title: "The launch failed", current: 3, failure: "runtime", note: { text: "The machine exists and was stopped to avoid charges after a problem. Retry setup tries again on the same machine; delete it if you would rather start over.", tone: "warning" } });
    expect(launchView(op({ state: "failed", stage: "preflight", errorCode: "cloud_provider_credential_invalid" }), { name: "x" }, "Boat"))
      .toMatchObject({ current: 1, failure: "key", note: { text: "No machine was created. Connect a working key, then launch again.", tone: "plain" } });
    expect(launchView(op({ state: "failed", stage: "creating-machine", errorCode: "cloud_workspace_provisioning_timeout" }), { name: "x" }, "Boat"))
      .toMatchObject({ current: 2, failure: "timeout", note: { text: "Delete it and launch a new one. Check Boat’s dashboard if a machine is still listed there.", tone: "warning" } });
  });

  it("while canceling, says it cleans up under the stage it reached", () => {
    expect(launchView(op({ state: "cancel-requested", stage: "cleanup", cancelable: false, events: [{ code: "machine-allocation-started", occurredAt: 1 }] }), { name: "x" }, "Boat"))
      .toMatchObject({ phase: "canceling", title: "Canceling…", current: 2, detail: "Cleaning up", note: { text: "Removing what was created so far." }, cancelable: false });
  });
});

describe("the provider's billing line", () => {
  it("is quoted after its name, and nothing more", () => {
    expect(billingLine({ label: "Boat", billing: "Per second, billed by Boat." })).toBe("Boat: per second, billed by Boat.");
    expect(billingLine({ label: "TerminalX Cloud", billing: "TerminalX bills this workspace" })).toBe("TerminalX Cloud: TerminalX bills this workspace.");
    expect(billingLine({ label: "Boat", billing: "  " })).toBeNull();
    expect(billingLine(null)).toBeNull();
    expect(diskLine({ label: "Boat", description: "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume." })).toBe("Boat: part of the disk resets on resume.");
    expect(diskLine({ label: "Boat", description: "Sandboxes on Boat." })).toBeNull();
    expect(diskLine(null)).toBeNull();
  });
});
