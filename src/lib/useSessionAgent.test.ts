import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@/lib/api";
import type { HarnessInfo, TabEntry } from "@/types/session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const model = (harness: string, id: string, efforts: string[], defaultEffort: string | null, isDefault = false): ModelInfo =>
  ({ id, label: id, harness, efforts, defaultEffort, acceptsImages: true, isDefault, upgrade: null, description: null });
const catalog = [
  model("claude", "opus", ["low", "medium", "high", "max"], "high", true),
  model("claude", "sonnet", ["low", "medium", "high"], "medium"),
  model("codex", "gpt-6", ["low", "medium", "high", "xhigh"], "medium", true),
  model("codex", "gpt-6-mini", ["low", "medium"], "low"),
];
vi.mock("@/lib/models", async (original) => ({
  // The pure helpers stay real; only the list and its loading are stubbed.
  ...(await original<typeof import("@/lib/models")>()),
  refreshModels: vi.fn(),
  useModels: (harness?: string) => catalog.filter((m) => !harness || m.harness === harness),
}));

const { launchSettingsOf, useSessionAgent } = await import("./useSessionAgent");
const { getPrefs, setPrefs } = await import("./prefs");
const { closeBypass, useDialogs } = await import("./dialogs");
type LaunchSettings = import("./useSessionAgent").LaunchSettings;

const harnesses = [
  { id: "claude", name: "Claude Code", available: true },
  { id: "codex", name: "Codex", available: true },
  { id: "gemini", name: "Gemini", available: false },
] as HarnessInfo[];
const source: LaunchSettings = { harness: "claude", model: "sonnet", effort: "low", permissionMode: "plan" };

function launch(start?: LaunchSettings, offered = harnesses) {
  return renderHook(() => ({ agent: useSessionAgent(offered, true, null, start), dialogs: useDialogs() }));
}

beforeEach(() => {
  closeBypass();
  setPrefs({ lastAgent: "codex", lastModel: { claude: "opus", codex: "gpt-6-mini" }, lastEffort: { claude: "max", codex: "low" }, lastMode: "auto", bypassConfirmed: false });
});

describe("launch settings", () => {
  it("launches what the preferences say on a surface with no start of its own", () => {
    const { result } = launch();
    expect(result.current.agent.settings).toEqual({ harness: "codex", model: "gpt-6-mini", effort: "low", permissionMode: "auto" });
  });

  it("starts from the source conversation's provider, model, effort and mode, not the preferences", () => {
    const { result } = launch(source);
    expect(result.current.agent.settings).toEqual(source);
  });

  it("starts from what the source tab was last asked to run, pending or not", () => {
    const tab = { harness: "claude", model: "opus", requestedModel: "sonnet", effort: "high", requestedEffort: "low", permissionMode: "auto", requestedPermissionMode: "plan" } as TabEntry;
    expect(launchSettingsOf(tab)).toEqual(source);
    expect(launchSettingsOf({ harness: "codex", model: "gpt-6", permissionMode: "manual" } as TabEntry)).toEqual({ harness: "codex", model: "gpt-6", effort: null, permissionMode: "manual" });
  });

  it("keeps the source's effort only while its model takes it", () => {
    expect(launch({ ...source, model: "opus", effort: "max" }).result.current.agent.effort).toBe("max");
    // Neither the source's "max" nor the saved "max" is a Sonnet effort: Sonnet's own default.
    expect(launch({ ...source, effort: "max" }).result.current.agent.effort).toBe("medium");
  });

  it("drops a model the provider no longer lists for the saved one", () => {
    const { result } = launch({ ...source, model: "claude-opus-4-1-20250805" });
    expect(result.current.agent.settings).toEqual({ harness: "claude", model: "opus", effort: "low", permissionMode: "plan" });
  });

  it("starts an uninstalled source provider's handoff on the saved provider, with that provider's own model and effort", () => {
    const { result } = launch({ ...source, harness: "gemini", model: "gemini-pro", effort: "high" });
    expect(result.current.agent.settings).toEqual({ harness: "codex", model: "gpt-6-mini", effort: "low", permissionMode: "plan" });
  });

  it("falls back to the first installed provider, and to nothing when none is", () => {
    setPrefs({ lastAgent: "gemini" });
    expect(launch({ ...source, harness: "gemini" }).result.current.agent.harness?.id).toBe("claude");
    const none = launch(source, harnesses.map((h) => ({ ...h, available: false })));
    expect(none.result.current.agent.harness).toBeNull();
    expect(none.result.current.agent.settings).toBeNull();
  });

  it("switches provider to that provider's saved model and effort, keeps the mode, and finds the source again on the way back", () => {
    const { result } = launch(source);
    act(() => result.current.agent.selectHarness("codex"));
    expect(result.current.agent.settings).toEqual({ harness: "codex", model: "gpt-6-mini", effort: "low", permissionMode: "plan" });
    expect(getPrefs().lastAgent).toBe("codex");
    act(() => result.current.agent.selectHarness("claude"));
    expect(result.current.agent.settings).toEqual(source);
  });

  it("falls back to the provider's default model and effort when nothing saved is valid", () => {
    setPrefs({ lastModel: { codex: "gpt-5-retired" }, lastEffort: { codex: "max" } });
    const { result } = launch(source);
    act(() => result.current.agent.selectHarness("codex"));
    expect(result.current.agent.settings).toEqual({ harness: "codex", model: "gpt-6", effort: "medium", permissionMode: "plan" });
  });

  it("shows the reader's picks over the source and saves them as the next launch's preferences", () => {
    const { result } = launch(source);
    act(() => result.current.agent.selectModel("opus"));
    act(() => result.current.agent.selectEffort("max"));
    expect(result.current.agent.settings).toEqual({ harness: "claude", model: "opus", effort: "max", permissionMode: "plan" });
    expect(getPrefs().lastModel.claude).toBe("opus");
    expect(getPrefs().lastEffort.claude).toBe("max");
  });

  it("ignores a model another provider lists and an effort the model does not take", () => {
    const { result } = launch(source);
    act(() => result.current.agent.selectModel("gpt-6"));
    act(() => result.current.agent.selectEffort("xhigh"));
    expect(result.current.agent.settings).toEqual(source);
  });

  it("takes Bypass permissions only once the reader agrees to it", () => {
    const { result } = launch(source);
    act(() => result.current.agent.selectMode("bypassPermissions"));
    expect(result.current.agent.permissionMode).toBe("plan");
    expect(result.current.dialogs.bypass?.harness).toBe("claude");
    act(() => result.current.dialogs.bypass!.confirm());
    expect(result.current.agent.permissionMode).toBe("bypassPermissions");
    expect(getPrefs().lastMode).toBe("bypassPermissions");
  });

  it("falls back to the saved mode when the source's mode is one the picker does not offer", () => {
    expect(launch({ ...source, permissionMode: "dontAsk" }).result.current.agent.permissionMode).toBe("auto");
    expect(launch({ ...source, permissionMode: "ask" }).result.current.agent.permissionMode).toBe("manual");
  });
});
