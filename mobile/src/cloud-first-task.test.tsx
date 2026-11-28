// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert, Keyboard } from "react-native";
import NewWorkspaceScreen from "../app/cloud/new";
import { BYPASS_NOT_FROM_PHONE } from "./cloud/agent-settings";
import { FIRST_TASK_PLACEHOLDER, NO_AGENT_TICKED, RUNTIME_PICKUP_MS, TASK_LEFT, TASK_NOTE, TASK_NOT_PICKED_UP, TASK_UNSURE_LEFT } from "./cloud/first-task";
import { LAUNCH_INVALID } from "./cloud/launch";
import { account, type HeldLaunch } from "./cloud/testing/account";
import { operation, refuse, workspace } from "./cloud/testing/server";
import { forgetConversationState } from "./state/conversation-state";
import { LAUNCH_POLL_MS, LaunchProgress, OPEN_AFTER_MS } from "./ui/LaunchProgress";
import { stage } from "./ui/testing/kit";

// PRO-547: a first task at launch (25.09). The form, the review and the progress page run against the real
// client and catalog, over an account service that keeps the launch intent and builds its view as the server does.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), dismissAll: vi.fn(), canDismiss: () => true },
  catalog: null as unknown,
  app: {} as unknown,
}));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return { ...native, KeyboardAvoidingView: native.View, ActivityIndicator: () => <i data-busy="true" />, Modal: ({ children }: { children?: unknown }) => <div role="dialog">{children as never}</div> };
});
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null }, useLocalSearchParams: () => mocks.params, useRouter: () => mocks.router, useFocusEffect: () => undefined, usePreventRemove: () => undefined }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("expo-crypto", () => ({ randomUUID: () => globalThis.crypto.randomUUID() }));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => "", hasStringAsync: async () => false }));
vi.mock("@mobile/cloud/CloudProvider", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: { subscribe: (listener: () => void) => () => void; getSnapshot: () => unknown }) => useSyncExternalStore(catalog.subscribe, catalog.getSnapshot) };
});

const page = stage();
const alert = vi.mocked(Alert.alert);
type Account = ReturnType<typeof account>;
let held: Account | null = null;

const pass = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const text = (id: string) => page.byId(id)?.textContent ?? null;
const disabled = (id: string) => page.byId(id)?.getAttribute("aria-disabled") === "true";
const field = (id: string) => page.byId(id)!.querySelector("input");
const label = (id: string) => page.byId(id)?.getAttribute("aria-label") ?? null;
const answer = async (choice: string) => {
  const buttons = alert.mock.calls.at(-1)![2]!;
  await act(async () => { buttons.find((button) => button.text === choice)!.onPress?.(); });
  await pass();
};
const rows = (id: string) => [...page.byId(id)!.querySelectorAll("[aria-label]")].map((row) => row.getAttribute("aria-label"));

async function signedIn(start: Parameters<typeof account>[0] = {}, change?: (service: Account) => void) {
  const service = account(start);
  change?.(service);
  held = service;
  mocks.catalog = service.catalog;
  await service.catalog.refresh();
  return service;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 24, 10, 0, 0));
  mocks.params = {};
  mocks.app = {};
  for (const spy of [mocks.router.back, mocks.router.push, mocks.router.replace, alert]) spy.mockReset();
});
afterEach(() => { held?.catalog.close(); held = null; forgetConversationState("cloud:"); vi.useRealTimers(); });

describe("the launch form's first task", () => {
  const form = async (start?: Parameters<typeof account>[0], change?: (service: Account) => void) => {
    const service = await signedIn(start, change);
    await page.show(<NewWorkspaceScreen />);
    await pass();
    return service;
  };
  const toReview = async () => {
    await page.type(field("workspace-name"), "Checkout redesign");
    await page.press(page.byId("review-price"));
    await pass();
  };
  const launch = async () => {
    await page.press(page.byId("launch"));
    await answer("Launch");
  };
  const task = () => page.byId("first-task")!.querySelector("input")!;

  it("is the form's last section: the first ticked agent, its own default model, Ask every time, and a task field", async () => {
    await form();
    expect(rows("first-task-rows")).toEqual(["Agent: Codex", "Model: Agent’s default", "Permission mode: Ask every time"]);
    // With no Mac connected to list them, there is no model to pick and no effort.
    expect(page.byId("pick-model")).toBeNull();
    expect(page.byId("pick-effort")).toBeNull();
    expect(task().getAttribute("data-multiline")).toBe("true");
    expect(task().getAttribute("placeholder")).toBe(FIRST_TASK_PLACEHOLDER);
    // Said only once a live check shows what an empty task does.
    expect(page.container.textContent).not.toContain("With no first task");
  });

  it("offers the four modes a phone may send, and says why bypass is not one of them", async () => {
    const service = await form();
    await page.type(task(), "Fix it");
    vi.mocked(Keyboard.dismiss).mockClear();
    await page.press(page.byId("pick-permission-mode"));
    // Opened while the task is typed: the keyboard goes, or it would cover the sheet.
    expect(Keyboard.dismiss).toHaveBeenCalledOnce();
    expect([...page.byId("choice-sheet")!.querySelectorAll("[data-testid^='choice-']")].map((row) => row.getAttribute("data-testid"))).toEqual(["choice-plan", "choice-manual", "choice-auto", "choice-acceptEdits"]);
    expect(page.byId("choice-sheet")!.textContent).toContain(BYPASS_NOT_FROM_PHONE);
    expect(page.byId("choice-sheet")!.textContent).not.toContain("Bypass permissions,");
    await page.press(page.byId("choice-plan"));
    expect(label("pick-permission-mode")).toBe("Permission mode: Plan");
    await toReview();
    await launch();
    expect((service.sent("POST", "/cloud-workspaces")[0].body as { launch: unknown }).launch).toEqual({ v: 1, agent: "codex", mode: "plan", prompt: "Fix it" });
  });

  it("chooses among the ticked agents, and moves the task to the next one when its agent is unticked", async () => {
    await form();
    await page.press(page.byId("pick-agent"));
    expect(page.byId("choice-sheet")!.textContent).toContain("The agents ticked for this workspace");
    expect(label("choice-codex")).toBe("Codex, alex@example.com");
    expect(page.byId("choice-claude")).not.toBeNull();
    await page.press(page.byId("choice-claude"));
    expect(label("pick-agent")).toBe("Agent: Claude Code");
    await page.press(page.byId("agent-claude"));
    expect(label("pick-agent")).toBe("Agent: Codex");
    // With nothing ticked there is nothing to start: the section says so, and the launch carries no task.
    await page.press(page.byId("agent-codex"));
    expect(page.byId("first-task-rows")).toBeNull();
    expect(text("first-task-none")).toBe(NO_AGENT_TICKED);
  });

  it("launches with no first task when no agent is ticked", async () => {
    const service = await form();
    await page.press(page.byId("agent-codex"));
    await page.press(page.byId("agent-claude"));
    await toReview();
    expect(page.byId("review-task")).toBeNull();
    await launch();
    expect(service.sent("POST", "/cloud-workspaces")[0].body).not.toHaveProperty("launch");
  });

  it("is not shown to a member, who cannot see the organization's logins", async () => {
    const service = await form({ role: "member" });
    expect(page.byId("first-task-rows")).toBeNull();
    expect(page.byId("first-task-none")).toBeNull();
    expect(page.container.textContent).not.toContain("First task");
    await toReview();
    await launch();
    expect(service.sent("POST", "/cloud-workspaces")[0].body).not.toHaveProperty("launch");
  });

  it("says a task over 32 KB is too long, and prices nothing until it fits", async () => {
    await form();
    await page.type(field("workspace-name"), "Checkout redesign");
    await page.type(task(), "é".repeat(16 * 1024 + 1));
    expect(text("first-task")).toContain("The first task is longer than 32 KB.");
    expect(disabled("review-price")).toBe(true);
    await page.type(task(), "é".repeat(16 * 1024));
    expect(text("first-task")).not.toContain("longer than 32 KB");
    expect(disabled("review-price")).toBe(false);
  });

  it("shows the task in the review's First task block, in full, and sends it as typed", async () => {
    const service = await form();
    const typed = `Fix the flaky checkout test. ${"Keep the public API. ".repeat(40)}`;
    await page.type(task(), typed);
    await toReview();
    expect(rows("review-task")).toEqual(["Agent: Codex", "Model: Agent’s default", "Permission mode: Ask every time", `Task: ${typed}`]);
    await launch();
    expect((service.sent("POST", "/cloud-workspaces")[0].body as { launch: unknown }).launch).toEqual({ v: 1, agent: "codex", mode: "manual", prompt: typed });
  });

  it("offers the model and effort the person's own Mac lists for the agent, and sends what is shown (PRO-562)", async () => {
    // The desktop's source for its create form: the models its own computer lists, family names for another machine.
    const listed = (harness: string, id: string, label: string, fields: Record<string, unknown> = {}) => ({ id, label, harness, efforts: ["low", "medium", "high"], defaultEffort: "medium", acceptsImages: true, isDefault: false, upgrade: null, description: null, ...fields });
    const models = vi.fn(async () => [
      listed("codex", "gpt-6.1-sol", "GPT-6.1 Sol", { isDefault: true, defaultEffort: "low" }), listed("codex", "gpt-6.1-mini", "GPT-6.1 Mini", { efforts: [] , defaultEffort: null }),
      listed("claude", "claude-opus-5-5", "Opus 5.5", { isDefault: true }), listed("claude", "opus", "Opus", { alias: true, defaultEffort: "high" }), listed("claude", "sonnet", "Sonnet", { alias: true }),
    ]);
    mocks.app = { connectionStage: "connected", api: { models } };
    const service = await form();
    expect(models).toHaveBeenCalledOnce();
    expect(rows("first-task-rows")).toEqual(["Agent: Codex", "Model: GPT-6.1 Sol", "Effort: Low", "Permission mode: Ask every time"]);
    await page.press(page.byId("pick-model"));
    expect(rows("choice-sheet").filter((row) => !row!.startsWith("Close"))).toEqual(["GPT-6.1 Sol", "GPT-6.1 Mini"]);
    // A model with no efforts has no Effort row.
    await page.press(page.byId("choice-gpt-6.1-mini"));
    expect(rows("first-task-rows")).toEqual(["Agent: Codex", "Model: GPT-6.1 Mini", "Permission mode: Ask every time"]);
    // Another agent starts on its own default: Claude Code's families only, each following its latest release.
    await page.press(page.byId("pick-agent"));
    await page.press(page.byId("choice-claude"));
    expect(rows("first-task-rows")).toEqual(["Agent: Claude Code", "Model: Opus", "Effort: High", "Permission mode: Ask every time"]);
    await page.press(page.byId("pick-model"));
    expect(rows("choice-sheet").filter((row) => !row!.startsWith("Close"))).toEqual(["Opus, latest", "Sonnet, latest"]);
    await page.press(page.byId("choice-sonnet"));
    await page.press(page.byId("pick-effort"));
    await page.press(page.byId("choice-high"));
    expect(rows("first-task-rows")).toEqual(["Agent: Claude Code", "Model: Sonnet", "Effort: High", "Permission mode: Ask every time"]);
    await toReview();
    expect(rows("review-task").slice(0, 3)).toEqual(["Agent: Claude Code", "Model: Sonnet · High", "Permission mode: Ask every time"]);
    await launch();
    expect((service.sent("POST", "/cloud-workspaces")[0].body as { launch: unknown }).launch).toEqual({ v: 1, agent: "claude", model: "sonnet", effort: "high", mode: "manual" });
  });

  it("leaves the model to the agent when the Mac is not connected or lists nothing", async () => {
    const models = vi.fn(async () => []);
    mocks.app = { connectionStage: "connecting", api: { models } };
    await form();
    expect(models).not.toHaveBeenCalled();
    expect(rows("first-task-rows")).toEqual(["Agent: Codex", "Model: Agent’s default", "Permission mode: Ask every time"]);
    mocks.app = { connectionStage: "connected", api: { models } };
    await page.show(<NewWorkspaceScreen key="connected" />);
    await pass();
    expect(models).toHaveBeenCalledOnce();
    expect(rows("first-task-rows")).toEqual(["Agent: Codex", "Model: Agent’s default", "Permission mode: Ask every time"]);
    expect(page.byId("pick-model")).toBeNull();
  });

  it("says None for an empty task, and sends no prompt", async () => {
    const service = await form();
    await page.type(task(), "   ");
    await toReview();
    expect(rows("review-task").at(-1)).toBe("Task: None");
    await launch();
    expect((service.sent("POST", "/cloud-workspaces")[0].body as { launch: unknown }).launch).toEqual({ v: 1, agent: "codex", mode: "manual" });
  });

  it("marks the Agent row when preflight finds the task's agent cannot sign in", async () => {
    await form({}, (made) => {
      made.state.preflight = { version: 1, ready: false, checks: [{ kind: "agent-credential", agent: "codex", status: "failed", errorCode: "cloud_agent_credential_reauth_required" }] };
    });
    await toReview();
    expect(text("preflight-problems")).toContain("Codex: sign-in required.");
    const value = [...page.byId("pick-agent")!.querySelectorAll("*")].find((node) => node.textContent === "Codex" && node.children.length === 0)!;
    expect(page.styleOf(value).color).toBe("#db695f");
  });

  it("says the desktop's sentence when the server refuses the task's settings", async () => {
    await form({}, (made) => { made.state.answer = (call) => (call.path === "/cloud-workspaces" && call.method === "POST" ? refuse("cloud_workspace_launch_invalid", 422) : undefined); });
    await page.type(task(), "Fix it");
    await toReview();
    await launch();
    expect(page.container.textContent).toContain(LAUNCH_INVALID);
  });

  it("is refused by the server's own parser in the same words, with a mode the phone never sends", async () => {
    const service = await signedIn();
    await expect(service.api.createWorkspace("org-1", { name: "x", quoteId: "quote_1", confirmProviderSpend: true, launch: { v: 1, agent: "codex", mode: "bypassPermissions" as never } }, globalThis.crypto.randomUUID())).rejects.toMatchObject({ code: "cloud_workspace_request_invalid" });
    expect(service.sent("POST", "/cloud-workspaces")).toHaveLength(0);
  });

  it("keeps the typed task for Launch again after the launch is canceled", async () => {
    const service = await form();
    await page.type(task(), "Fix the checkout test");
    await page.press(page.byId("pick-permission-mode"));
    await page.press(page.byId("choice-acceptEdits"));
    await toReview();
    await launch();
    const made = (service.sent("POST", "/cloud-workspaces")[0]);
    expect(made).toBeDefined();
    const workspaceId = [...service.state.workspaces.keys()].at(-1)!;
    // The form is opened again for the canceled launch: the task, its agent and its mode are put back.
    mocks.params = { orgId: "org-1", from: workspaceId };
    await page.show(<></>);
    await page.show(<NewWorkspaceScreen />);
    await pass();
    expect(task().value).toBe("Fix the checkout test");
    expect(label("pick-permission-mode")).toBe("Permission mode: Accept edits");
    // Put back once: opened again without it, the form starts empty.
    mocks.params = { orgId: "org-1" };
    await page.show(<></>);
    await page.show(<NewWorkspaceScreen />);
    await pass();
    expect(task().value).toBe("");
  });
});

describe("a launch with a first task, in progress", () => {
  const launched = async (op: Record<string, unknown> = {}, ws: Record<string, unknown> = {}, launch: Partial<HeldLaunch> = {}, role?: "owner" | "admin" | "member") => {
    const service = await signedIn({ role, workspaces: [{ workspace: workspace(ws), latestOperation: operation(op), launch: { agent: "claude", promptBytes: 21, createdAt: Date.now(), ...launch } }] });
    const on = { onOpen: vi.fn(), onDelete: vi.fn(), onRetried: vi.fn(), onBack: vi.fn(), onLaunchAgain: vi.fn(), onFixKey: vi.fn(), onAgentLogins: vi.fn() };
    await page.show(<LaunchProgress catalog={service.catalog} orgId="org-1" operationId="op-9" title="Checkout redesign" {...on} />);
    await pass();
    return { service, on };
  };
  const stages = () => [0, 1, 2, 3, 4, 5].map((index) => label(`operation-stage-${index}`));

  it("follows launch.phase through six rows, and opens the conversation at the launch's tab", async () => {
    const { service, on } = await launched({ state: "queued", stage: "queued" });
    expect(text("launch-head")).toBe("Launching…");
    expect(stages()).toEqual(["Creating the machine, in progress: Queued", "Installing the runtime, not started", "Connecting to the runtime, not started", "Syncing the repository, not started", "Starting the agent, not started", "Running, not started"]);
    expect(disabled("cancel-launch")).toBe(false);
    service.advance("op-9", { state: "running", stage: "bootstrapping", cancelable: false, events: [{ code: "credentials-installing", occurredAt: 5 }] });
    await pass(LAUNCH_POLL_MS);
    expect(stages()[1]).toMatch(/^Installing the runtime, in progress/);
    expect(disabled("cancel-launch")).toBe(true);
    service.advance("op-9", { stage: "connecting-relay" });
    // The machine runs: the page goes on with the agent, and the workspace may be opened already.
    service.advance("op-9", { state: "succeeded", stage: "ready" }, { state: "ready" });
    await pass(LAUNCH_POLL_MS);
    expect(text("launch-head")).toBe("Starting the agent…");
    expect(stages()[2]).toBe("Connecting to the runtime, in progress");
    expect(text("launch-note")).toBe(TASK_NOTE.next);
    expect(page.byId("cancel-launch")).toBeNull();
    service.advanceLaunch("ws-9", { state: "claimed", syncingAt: Date.now() });
    await pass(LAUNCH_POLL_MS);
    expect(stages()[3]).toBe("Syncing the repository, in progress");
    service.advanceLaunch("ws-9", { startingAgentAt: Date.now() });
    await pass(LAUNCH_POLL_MS);
    expect(stages()[4]).toBe("Starting the agent, in progress: Claude Code");
    expect(on.onOpen).not.toHaveBeenCalled();
    service.advanceLaunch("ws-9", { state: "started", runningAt: Date.now(), sessionId: "s-1", tabId: "tab-7" });
    await pass(LAUNCH_POLL_MS);
    expect(stages()[5]).toBe("Running, done");
    expect(text("launch-note")).toBe(TASK_NOTE.working);
    await pass(OPEN_AFTER_MS);
    expect(on.onOpen).toHaveBeenCalledWith("tab-7");
    // Settled: no more reads.
    const reads = service.calls.length;
    await pass(LAUNCH_POLL_MS * 3);
    expect(service.calls.length).toBe(reads);
  });

  it("says the agent is ready when it had no task to work on", async () => {
    await launched({ state: "succeeded", stage: "ready" }, { state: "ready" }, { state: "started", promptBytes: 0, tabId: "tab-2" });
    expect(text("launch-note")).toBe(TASK_NOTE.ready);
  });

  it("warns, without failing, when the running workspace's runtime leaves the task unclaimed for two minutes", async () => {
    const { service } = await launched({ state: "succeeded", stage: "ready" }, { state: "ready" });
    service.advance("op-9", { stage: "connecting-relay" });
    service.advance("op-9", { stage: "ready" });
    await pass(LAUNCH_POLL_MS);
    expect(page.byId("launch-not-picked-up")).toBeNull();
    await pass(RUNTIME_PICKUP_MS);
    expect(text("launch-not-picked-up")).toBe(TASK_NOT_PICKED_UP);
    expect(text("launch-head")).toBe("Starting the agent…");
    expect(page.byId("open-workspace")).not.toBeNull();
  });

  it("says why the task did not start, what it left, and sends an owner or admin to Agent logins", async () => {
    const { on } = await launched({ state: "succeeded", stage: "ready" }, { state: "ready" }, { state: "failed", category: "agent-sign-in-required", startingAgentAt: Date.now() });
    expect(text("launch-head")).toBe("The first task did not start");
    expect(stages()[4]).toMatch(/^Starting the agent, failed: The agent has no working login in this workspace, so the first prompt was not sent\. .* An owner or admin can see which in Agent logins\.$/);
    expect(text("launch-left")).toBe(TASK_LEFT);
    await page.press(page.byId("agent-logins"));
    expect(on.onAgentLogins).toHaveBeenCalledOnce();
    await page.press(page.byId("open-workspace"));
    expect(on.onOpen).toHaveBeenCalledWith(null);
  });

  it("offers a member only Open workspace when the agent's login failed", async () => {
    await launched({ state: "succeeded", stage: "ready" }, { state: "ready" }, { state: "failed", category: "agent_credential_expired" }, "member");
    expect(page.byId("agent-logins")).toBeNull();
    expect(page.byId("open-workspace")).not.toBeNull();
  });

  it("says the task may not have been sent when the runtime could not tell", async () => {
    await launched({ state: "succeeded", stage: "ready" }, { state: "ready" }, { state: "failed", category: "prompt-send-failed", startingAgentAt: Date.now(), tabId: "tab-3" });
    expect(text("launch-head")).toBe("The first task may not have been sent");
    expect(stages()[4]).toBe("Starting the agent, failed: The agent started, but the first task may not have reached it.");
    expect(text("launch-left")).toBe(TASK_UNSURE_LEFT);
    await launched({ state: "succeeded", stage: "ready" }, { state: "ready" }, { state: "outcome-unknown" });
    expect(text("launch-head")).toBe("The first task may not have been sent");
  });

  it("gives 25.05's failure page when the machine failed with its task still waiting, and says the task is kept for Retry setup", async () => {
    await launched({ state: "failed", stage: "bootstrapping", errorCode: "cloud_workspace_bootstrap_failed" }, { state: "attention-required" });
    expect(text("launch-head")).toBe("The launch failed");
    // The machine failed at Installing the runtime; the cross stays there.
    expect(stages()[1]).toMatch(/^Installing the runtime, failed/);
    expect(page.byId("retry-setup")).not.toBeNull();
    expect(text("launch-task-kept")).toBe(TASK_NOTE.kept);
  });

  it("says the first prompt was not sent when the launch is canceled", async () => {
    const { on } = await launched({ state: "canceled", stage: "cleanup", cancelable: false }, { state: "destroyed" }, { state: "canceled" });
    expect(text("launch-head")).toBe("Launch canceled");
    expect(text("launch-note")).toBe(TASK_NOTE.canceled);
    await page.press(page.byId("launch-again"));
    expect(on.onLaunchAgain).toHaveBeenCalledOnce();
  });
});
