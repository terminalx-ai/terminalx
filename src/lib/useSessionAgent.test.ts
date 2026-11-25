import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReadinessMap } from "./agentReadiness";
import type { ModelInfo } from "@/lib/api";
import { closeBypass, useDialogs } from "@/lib/dialogs";
import { getPrefs, setPrefs } from "@/lib/prefs";
import type { HarnessInfo, TabEntry } from "@/types/session";
import { forgetAgentAccounts, handoffStart, launchDefaults, launchSettingsOf, takeAgentAccounts, useSessionAgent, type LaunchSettings } from "./useSessionAgent";
import type { AgentAccount, AgentAccounts } from "./agentAccounts";

// The Mac's account index (#980), as `agent_accounts_list` answers it: per agent, or refused.
const index = vi.hoisted(() => ({ views: {} as Record<string, unknown>, calls: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: { harness: string }) => {
    if (command !== "agent_accounts_list") throw new Error(`unexpected command ${command}`);
    index.calls.push(args.harness);
    if (!index.views[args.harness]) throw new Error("no index");
    return index.views[args.harness];
  }),
}));

const catalog = vi.hoisted(() => ({ models: [] as ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: (harness?: string) => catalog.models.filter((m) => !harness || m.harness === harness),
}));

const model = (id: string, harness: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id, label: id, harness, efforts: [], defaultEffort: null, acceptsImages: true, isDefault: false, upgrade: null, description: null, ...extra,
});
const HARNESSES = [
  { id: "claude", name: "Claude Code", available: true },
  { id: "codex", name: "Codex", available: true },
] as HarnessInfo[];

/** A form that owns its launch settings, as the cloud forms do. */
function useForm(initial: LaunchSettings) {
  const [value, setValue] = useState(initial);
  return { value, setValue, selection: useSessionAgent(HARNESSES, true, null, { value, onChange: setValue }) };
}

beforeEach(() => {
  catalog.models = [
    model("opus", "claude", { isDefault: true, efforts: ["low", "high", "max"], defaultEffort: "high" }),
    model("sonnet", "claude", { efforts: ["low", "high"], defaultEffort: "high" }),
    model("gpt-6-astra", "codex", { isDefault: true, efforts: ["low", "medium"], defaultEffort: "medium" }),
    model("gpt-5.6-sol", "codex", { efforts: ["medium", "high"], defaultEffort: "high" }),
  ];
  setPrefs({ lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "bypassPermissions", bypassConfirmed: false });
  closeBypass();
  index.views = {};
  index.calls = [];
  forgetAgentAccounts();
});
afterEach(cleanup);

describe("launch settings from preferences", () => {
  it("uses an installed local agent when the saved agent is missing without overwriting preferences", () => {
    setPrefs({ lastModel: { codex: "gpt-6-astra" }, lastEffort: { codex: "medium" } });
    const agents = HARNESSES.map((h) => ({ ...h, available: h.id === "codex" }));
    const { result } = renderHook(() => useSessionAgent(agents));
    expect(result.current.harness?.id).toBe("codex");
    expect(result.current.modelId).toBe("gpt-6-astra");
    expect(result.current.effort).toBe("medium");
    expect(getPrefs().lastAgent).toBe("claude");
  });

  it("keeps cloud and explicitly controlled choices independent of local installation", () => {
    const agents = HARNESSES.map((h) => ({ ...h, available: h.id === "codex" }));
    const cloud = renderHook(() => useSessionAgent(agents, false));
    const controlled = renderHook(() => useSessionAgent(agents, true, null, { value: launchDefaults(), onChange: vi.fn() }));
    expect(cloud.result.current.harness?.id).toBe("claude");
    expect(controlled.result.current.harness?.id).toBe("claude");
  });

  it("reads the saved mode in the picker's own spelling, and Ask every time for one it does not offer", () => {
    setPrefs({ lastMode: "ask" });
    const { result, rerender } = renderHook(() => useSessionAgent(HARNESSES));
    expect(result.current.mode).toBe("manual");
    // Never Bypass for a saved mode the picker cannot read: that is no choice, and starts where a fresh profile does.
    setPrefs({ lastMode: "dontAsk" });
    rerender();
    expect(result.current.mode).toBe("manual");
  });

  it("starts a fresh profile's new chats in Ask every time, then in whatever the reader picked (PRO-162)", async () => {
    localStorage.clear();
    vi.resetModules();
    const fresh = await import("./useSessionAgent");
    const prefs = await import("@/lib/prefs");
    expect(fresh.launchDefaults().permissionMode).toBe("manual");
    const { result } = renderHook(() => fresh.useSessionAgent(HARNESSES));
    expect(result.current.mode).toBe("manual");

    act(() => result.current.selectMode("plan"));
    expect(prefs.getPrefs().lastMode).toBe("plan");
    // After a restart the pick is where the next new chat starts.
    vi.resetModules();
    const restarted = await import("./useSessionAgent");
    expect(restarted.launchDefaults().permissionMode).toBe("plan");
    expect(renderHook(() => restarted.useSessionAgent(HARNESSES)).result.current.mode).toBe("plan");
  });

  it("saves a mode that leaves something asking at once", () => {
    const { result } = renderHook(() => useSessionAgent(HARNESSES));
    act(() => result.current.selectMode("acceptEdits"));
    expect(getPrefs().lastMode).toBe("acceptEdits");
    expect(result.current.mode).toBe("acceptEdits");
  });
});

describe("new-chat login defaults", () => {
  const readiness = (claude: "ready" | "signed_out" | "unknown", codex: "ready" | "signed_out" | "unknown"): AgentReadinessMap => ({
    claude: { state: claude, checkedAt: null, version: null },
    codex: { state: codex, checkedAt: null, version: null },
  });
  it("selects nothing while login checks are pending or neither agent is signed in", () => {
    const { result, rerender } = renderHook(({ value }) => useSessionAgent(HARNESSES, true, null, undefined, value), { initialProps: { value: null as AgentReadinessMap | null } });
    expect(result.current.harness).toBeNull();
    rerender({ value: readiness("signed_out", "signed_out") });
    expect(result.current.harness).toBeNull();
    expect(result.current.modelId).toBe("");
  });
  it.each(["claude", "codex"])("uses %s when it is the only signed-in agent, keeping its own model and effort", (id) => {
    setPrefs({ lastAgent: id === "claude" ? "codex" : "claude", lastModel: { claude: "sonnet", codex: "gpt-5.6-sol" }, lastEffort: { claude: "low", codex: "high" }, lastMode: "plan" });
    const before = getPrefs();
    const value = readiness(id === "claude" ? "ready" : "signed_out", id === "codex" ? "ready" : "signed_out");
    const { result } = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, value));
    expect(result.current.harness?.id).toBe(id);
    expect(result.current.modelId).toBe(before.lastModel[id]);
    expect(result.current.effort).toBe(before.lastEffort[id]);
    expect(result.current.mode).toBe("plan");
    expect(getPrefs()).toEqual(before);
  });
  it.each(["claude", "codex"])("keeps remembered %s settings when both agents are signed in, across composer mounts", (id) => {
    setPrefs({ lastAgent: id });
    const value = readiness("ready", "ready");
    const first = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, value));
    act(() => first.result.current.selectModel(id === "claude" ? "sonnet" : "gpt-5.6-sol"));
    act(() => first.result.current.selectEffort("high"));
    act(() => first.result.current.selectMode("plan"));
    first.unmount();
    const next = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, value));
    expect(next.result.current.harness?.id).toBe(id);
    expect(next.result.current.modelId).toBe(id === "claude" ? "sonnet" : "gpt-5.6-sol");
    expect(next.result.current.effort).toBe("high");
    expect(next.result.current.mode).toBe("plan");
  });
  it("prefers a verified login to a saved unknown probe but permits unknown custom routes when no login is verified", () => {
    const { result, rerender } = renderHook(({ value }) => useSessionAgent(HARNESSES, true, null, undefined, value), { initialProps: { value: readiness("unknown", "ready") } });
    expect(result.current.harness?.id).toBe("codex");
    act(() => result.current.selectHarness("claude"));
    expect(result.current.harness?.id).toBe("claude");
    rerender({ value: readiness("unknown", "signed_out") });
    expect(result.current.harness?.id).toBe("claude");
  });
});

describe("a form's own launch settings", () => {
  it("starts from what New Session would launch with", () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" }, lastMode: "plan" });
    expect(launchDefaults()).toEqual({ harness: "codex", model: "gpt-5.6-sol", effort: "high", permissionMode: "plan" });
    const { result } = renderHook(() => useForm(launchDefaults()));
    const { harness, modelId, effort, mode } = result.current.selection;
    expect({ harness: harness?.id, modelId, effort, mode }).toEqual({ harness: "codex", modelId: "gpt-5.6-sol", effort: "high", mode: "plan" });
  });

  it("switches agent to that agent's saved model and effort, and saves nothing", () => {
    setPrefs({ lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" } });
    const { result } = renderHook(() => useForm(launchDefaults()));
    act(() => result.current.selection.selectModel("sonnet"));
    act(() => result.current.selection.selectHarness("codex"));
    expect(result.current.value).toEqual({ harness: "codex", model: "gpt-5.6-sol", effort: "high", permissionMode: "bypassPermissions" });
    // The same agent again keeps what was picked for it.
    act(() => result.current.selection.selectModel("gpt-6-astra"));
    act(() => result.current.selection.selectHarness("codex"));
    expect(result.current.value.model).toBe("gpt-6-astra");
    expect(getPrefs()).toMatchObject({ lastAgent: "claude", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" } });
  });

  it("keeps an effort the new model takes and drops one it does not", () => {
    const { result } = renderHook(() => useForm(launchDefaults()));
    act(() => result.current.selection.selectEffort("low"));
    act(() => result.current.selection.selectModel("sonnet"));
    expect(result.current.value).toMatchObject({ model: "sonnet", effort: "low" });
    act(() => result.current.selection.selectModel("opus"));
    act(() => result.current.selection.selectEffort("max"));
    act(() => result.current.selection.selectModel("sonnet"));
    expect(result.current.value).toMatchObject({ model: "sonnet", effort: null });
    expect(result.current.selection.effort).toBe("high");
  });

  it("lets the new model's own default apply where no effort was picked, as New Session does", () => {
    setPrefs({ lastAgent: "codex" });
    const { result } = renderHook(() => useForm(launchDefaults()));
    expect(result.current.selection.effort).toBe("medium");
    // Medium was only GPT-6 Astra's default; GPT-5.6 Sol's own is High.
    act(() => result.current.selection.selectModel("gpt-5.6-sol"));
    expect(result.current.value.effort).toBeNull();
    expect(result.current.selection.effort).toBe("high");
    const newSession = renderHook(() => useSessionAgent(HARNESSES));
    act(() => newSession.result.current.selectModel("gpt-5.6-sol"));
    expect(newSession.result.current.effort).toBe("high");
  });

  it("ignores a model or effort the list does not offer", () => {
    const { result } = renderHook(() => useForm(launchDefaults()));
    act(() => result.current.selection.selectModel("gpt-6-astra"));
    act(() => result.current.selection.selectEffort("medium"));
    expect(result.current.value).toEqual(launchDefaults());
  });

  it("applies bypass only once agreed, to the settings as they are then", () => {
    setPrefs({ lastMode: "manual" });
    const dialogs = renderHook(() => useDialogs());
    const { result } = renderHook(() => useForm(launchDefaults()));
    act(() => result.current.selection.selectMode("bypassPermissions"));
    expect(dialogs.result.current.bypass?.harness).toBe("claude");
    expect(result.current.value.permissionMode).toBe("manual");
    // Something else changed while the question was up: the answer must not undo it.
    act(() => result.current.setValue((current) => ({ ...current, model: "sonnet" })));
    act(() => dialogs.result.current.bypass?.confirm());
    expect(result.current.value).toMatchObject({ model: "sonnet", permissionMode: "bypassPermissions" });
    expect(getPrefs().lastMode).toBe("manual");
  });
});

describe("a cloud form before any workspace has said what it runs (#1580)", () => {
  /** The create form: no workspace yet, so the list is this computer's. */
  function useCloudForm(initial: LaunchSettings) {
    const [value, setValue] = useState(initial);
    return { value, selection: useSessionAgent(HARNESSES, false, null, { value, onChange: setValue }) };
  }

  it("sends no Codex model it was not given here: this computer's saved one may not run there", () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" }, lastEffort: { codex: "high" } });
    const { result } = renderHook(() => useCloudForm(launchDefaults()));
    const { harness, modelId, model, effort, agentDefault } = result.current.selection;
    expect({ harness: harness?.id, modelId, model, effort, agentDefault }).toEqual({ harness: "codex", modelId: "", model: null, effort: null, agentDefault: true });
    // This computer's list is still offered, to pick from.
    expect(result.current.selection.models.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
  });

  it("sends a Codex model picked in the form, and its effort", () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" } });
    const { result } = renderHook(() => useCloudForm(launchDefaults()));
    act(() => result.current.selection.selectModel("gpt-5.6-sol"));
    act(() => result.current.selection.selectEffort("medium"));
    const { modelId, effort, agentDefault } = result.current.selection;
    expect({ modelId, effort, agentDefault }).toEqual({ modelId: "gpt-5.6-sol", effort: "medium", agentDefault: false });
  });

  it("still sends a family alias, which every machine's CLI takes", () => {
    catalog.models = catalog.models.map((m) => (m.id === "opus" ? { ...m, alias: true } : m));
    const { result } = renderHook(() => useCloudForm(launchDefaults()));
    expect(result.current.selection.modelId).toBe("opus");
    expect(result.current.selection.agentDefault).toBe(false);
  });

  it("keeps this computer's saved Codex model for a start on this computer", () => {
    setPrefs({ lastAgent: "codex", lastModel: { codex: "gpt-5.6-sol" } });
    const { result } = renderHook(() => useForm(launchDefaults()));
    expect(result.current.selection.modelId).toBe("gpt-5.6-sol");
    expect(result.current.selection.agentDefault).toBe(false);
  });
});

describe("where a handoff starts", () => {
  const source: LaunchSettings = { harness: "claude", model: "sonnet", effort: "low", permissionMode: "plan" };
  const start = (from: Partial<LaunchSettings>, harnesses = HARNESSES) => handoffStart({ ...source, ...from }, harnesses, catalog.models, getPrefs());
  beforeEach(() => {
    setPrefs({ lastAgent: "codex", lastModel: { claude: "opus", codex: "gpt-5.6-sol" }, lastEffort: { claude: "max", codex: "medium" }, lastMode: "auto" });
  });

  it("is the source conversation's provider, model, effort and mode, not the preferences", () => {
    expect(start({})).toEqual(source);
  });

  it("takes what the source tab was last asked to run, pending or not", () => {
    const tab = { harness: "claude", model: "opus", requestedModel: "sonnet", effort: "high", requestedEffort: "low", permissionMode: "auto", requestedPermissionMode: "plan" } as TabEntry;
    expect(launchSettingsOf(tab)).toEqual(source);
    expect(launchSettingsOf({ harness: "codex", model: "gpt-6-astra", permissionMode: "manual" } as TabEntry)).toEqual({ harness: "codex", model: "gpt-6-astra", effort: null, permissionMode: "manual" });
  });

  it("keeps the source's effort only while its model takes it, then the saved one, then the model's own default", () => {
    expect(start({ model: "opus", effort: "max" })?.effort).toBe("max");
    // Sonnet takes neither the source's "max" nor the saved "max": null, which the form shows as Sonnet's default.
    expect(start({ effort: "max" })?.effort).toBeNull();
  });

  it("drops a model the provider no longer lists for the saved one", () => {
    expect(start({ model: "claude-opus-4-1-20250805" })).toEqual({ harness: "claude", model: "opus", effort: "low", permissionMode: "plan" });
  });

  it("starts an uninstalled source provider's handoff on the saved provider, with that provider's own model and effort", () => {
    expect(start({ harness: "gemini", model: "gemini-pro", effort: "high" })).toEqual({ harness: "codex", model: "gpt-5.6-sol", effort: "medium", permissionMode: "plan" });
  });

  it("falls back to the first installed provider, and to nothing when none is", () => {
    setPrefs({ lastAgent: "gemini" });
    expect(start({ harness: "gemini" })?.harness).toBe("claude");
    expect(start({}, HARNESSES.map((h) => ({ ...h, available: false })))).toBeNull();
  });

  it("starts a mode the picker does not offer in Ask every time, never in a looser saved mode", () => {
    setPrefs({ lastMode: "bypassPermissions" });
    for (const reported of ["dontAsk", "untrusted, read-only", "never, workspace-write", "never, danger-full-access", "terminal"]) {
      expect(start({ permissionMode: reported })?.permissionMode).toBe("manual");
    }
    // An older spelling of a picker mode is that mode.
    expect(start({ permissionMode: "ask" })?.permissionMode).toBe("manual");
    expect(start({ permissionMode: "accept_edits" })?.permissionMode).toBe("acceptEdits");
    // A source that names no mode at all starts from the saved one.
    expect(start({ permissionMode: "" })?.permissionMode).toBe("bypassPermissions");
  });
});

// #980, docs/AGENT-ACCOUNTS.md: the account a session starts on.
describe("the account a launch starts on", () => {
  const WORK = "0123456789abcdef";
  const PERSONAL = "fedcba9876543210";
  const account = (agent: "claude" | "codex", id: string, label: string, extra: Partial<AgentAccount> = {}): AgentAccount => ({
    id, agent, kind: "subscription", label, email: null, plan: null, organization: null, local: id === "local", isDefault: false, missing: false, addedAt: null, ...extra,
  });
  const view = (agent: "claude" | "codex", accounts: AgentAccount[], defaultAccount = "local", projectDefaults: Record<string, string> = {}): AgentAccounts =>
    ({ agent, accounts: accounts.map((a) => ({ ...a, isDefault: a.id === defaultAccount })), defaultAccount, projectDefaults });
  const local = (agent: "claude" | "codex" = "claude") => account(agent, "local", "This Mac's login");
  const several = (projectDefaults: Record<string, string> = {}) =>
    view("claude", [local(), account("claude", WORK, "work@example.com · Max"), account("claude", PERSONAL, "me@example.com · Pro")], "local", projectDefaults);

  it("offers no choice and names no account with one account, as before accounts", async () => {
    index.views.claude = view("claude", [local()]);
    const { result } = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, undefined, "/repos/raccoon"));
    await waitFor(() => expect(index.calls).toContain("claude"));
    await act(async () => {});
    expect(result.current.accounts).toBeNull();
    expect(result.current.account).toBeNull();
    expect(result.current.accountId).toBeUndefined();
  });

  it("offers no choice when the index cannot be read, or for a cloud start", async () => {
    const { result } = renderHook(() => useSessionAgent(HARNESSES));
    await waitFor(() => expect(index.calls).toContain("claude"));
    await act(async () => {});
    expect(result.current.accounts).toBeNull();
    index.views.claude = several();
    index.calls = [];
    const cloud = renderHook(() => useSessionAgent(HARNESSES, false));
    await act(async () => {});
    // A cloud workspace signs its agents in itself: this Mac's accounts are not asked for.
    expect(index.calls).toEqual([]);
    expect(cloud.result.current.accounts).toBeNull();
  });

  it("shows two accounts, starting on the project's default, then the agent's, and on the one picked", async () => {
    index.views.claude = several({ "/repos/raccoon": WORK });
    const inProject = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, undefined, "/repos/raccoon"));
    await waitFor(() => expect(inProject.result.current.accounts?.accounts).toHaveLength(3));
    expect(inProject.result.current.account?.label).toBe("work@example.com · Max");
    expect(inProject.result.current.accountId).toBe(WORK);

    const elsewhere = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, undefined, "/repos/other"));
    expect(elsewhere.result.current.accountId).toBe("local");

    act(() => inProject.result.current.selectAccount(PERSONAL));
    expect(inProject.result.current.accountId).toBe(PERSONAL);
    // A pick is this start's own: it is never saved as a preference.
    expect(JSON.stringify(getPrefs())).not.toContain(PERSONAL);
    // An id the agent does not list is no choice.
    act(() => inProject.result.current.selectAccount("ffffffffffffffff"));
    expect(inProject.result.current.accountId).toBe(PERSONAL);
  });

  it("follows an agent's default set elsewhere, and a project default set in its settings", async () => {
    index.views.claude = several();
    const { result } = renderHook(() => useSessionAgent(HARNESSES, true, null, undefined, undefined, "/repos/raccoon"));
    await waitFor(() => expect(result.current.accountId).toBe("local"));
    act(() => takeAgentAccounts(several({ "/repos/raccoon": PERSONAL })));
    expect(result.current.accountId).toBe(PERSONAL);
  });

  it("keeps a controlled form's account in its value, and drops it for another agent", async () => {
    index.views.claude = several({ "/repos/raccoon": WORK });
    index.views.codex = view("codex", [local("codex"), account("codex", WORK, "Team ChatGPT")]);
    const { result } = renderHook(() => {
      const [value, setValue] = useState<LaunchSettings>({ ...launchDefaults(), account: PERSONAL });
      return { value, selection: useSessionAgent(HARNESSES, true, null, { value, onChange: setValue }, undefined, "/repos/raccoon") };
    });
    // The form's account wins over the project default.
    await waitFor(() => expect(result.current.selection.accountId).toBe(PERSONAL));
    act(() => result.current.selection.selectAccount(WORK));
    expect(result.current.value.account).toBe(WORK);
    act(() => result.current.selection.selectHarness("codex"));
    expect(result.current.value.harness).toBe("codex");
    expect(result.current.value.account).toBeUndefined();
    await waitFor(() => expect(result.current.selection.accounts?.agent).toBe("codex"));
    // Codex has no project default here: its own default.
    expect(result.current.selection.accountId).toBe("local");
  });

  it("carries the source conversation's account into a handoff on its own agent only", () => {
    const tab = { harness: "claude", model: "sonnet", effort: "low", permissionMode: "plan", launchedAccount: WORK } as unknown as TabEntry;
    const source = launchSettingsOf(tab);
    expect(source.account).toBe(WORK);
    expect(handoffStart(source, HARNESSES, catalog.models, getPrefs())?.account).toBe(WORK);
    // On another agent the account is that agent's to resolve.
    expect(handoffStart(source, HARNESSES.filter((h) => h.id === "codex"), catalog.models, getPrefs())).not.toHaveProperty("account");
    // A tab on This Mac's login records none, and carries none.
    expect(launchSettingsOf({ ...tab, launchedAccount: undefined } as unknown as TabEntry)).not.toHaveProperty("account");
  });
});
