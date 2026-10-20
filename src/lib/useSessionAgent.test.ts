import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@/lib/api";
import { closeBypass, useDialogs } from "@/lib/dialogs";
import { getPrefs, setPrefs } from "@/lib/prefs";
import type { HarnessInfo, TabEntry } from "@/types/session";
import { handoffStart, launchDefaults, launchSettingsOf, useSessionAgent, type LaunchSettings } from "./useSessionAgent";

const catalog = vi.hoisted(() => ({ models: [] as ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: (harness?: string) => catalog.models.filter((m) => m.harness === harness),
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
});
afterEach(cleanup);

describe("launch settings from preferences", () => {
  it("reads the saved mode in the picker's own spelling, and the default for one it does not offer", () => {
    setPrefs({ lastMode: "ask" });
    const { result, rerender } = renderHook(() => useSessionAgent(HARNESSES));
    expect(result.current.mode).toBe("manual");
    setPrefs({ lastMode: "dontAsk" });
    rerender();
    expect(result.current.mode).toBe("bypassPermissions");
  });

  it("saves a mode that leaves something asking at once", () => {
    const { result } = renderHook(() => useSessionAgent(HARNESSES));
    act(() => result.current.selectMode("acceptEdits"));
    expect(getPrefs().lastMode).toBe("acceptEdits");
    expect(result.current.mode).toBe("acceptEdits");
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
