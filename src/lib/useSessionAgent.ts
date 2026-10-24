import { useRef } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { DEFAULT_PERMISSION_MODE, pickerMode, useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { chooseMode } from "@/lib/dialogs";
import { getPrefs, setPrefs, usePrefs, type Prefs } from "@/lib/prefs";
import type { ModelInfo } from "@/lib/api";
import type { HarnessInfo, TabEntry } from "@/types/session";

/** One launch: the agent, its model and effort, and the permission mode it starts in. */
export interface LaunchSettings {
  harness: string;
  model: string;
  effort: string | null;
  permissionMode: string;
  pipeline?: import("@/lib/pipelineLaunch").PipelineLaunch;
}

/**
 * A form that keeps its own launch settings (a cloud workspace's first agent,
 * another agent tab in one): nothing it picks is saved as a preference.
 */
export interface ControlledLaunch {
  value: LaunchSettings;
  onChange: (next: LaunchSettings) => void;
  /** Keep unknown saved models visible until the reader replaces them. */
  preserveUnavailableModel?: boolean;
  /** Offer null explicitly instead of displaying the model's default effort. */
  allowDefaultEffort?: boolean;
  /** The surface supplies a persistent unattended-run warning. */
  bypassWarning?: boolean;
}

/** What New Session would launch with now: where a controlled form starts. */
export function launchDefaults(prefs: Prefs = getPrefs()): LaunchSettings {
  return {
    harness: prefs.lastAgent,
    model: prefs.lastModel[prefs.lastAgent] ?? "",
    effort: prefs.lastEffort[prefs.lastAgent] ?? null,
    permissionMode: prefs.lastMode,
  };
}

/** A tab's settings, as what it was last asked to run, pending or not. */
export function launchSettingsOf(tab: TabEntry): LaunchSettings {
  return {
    harness: tab.harness,
    model: tab.requestedModel || tab.model,
    effort: tab.requestedEffort ?? tab.effort ?? null,
    permissionMode: tab.requestedPermissionMode || tab.permissionMode,
  };
}

/**
 * Where a start's mode lands when the picker does not offer it: one its agent
 * reported (Claude Code's `dontAsk`, a Codex approval and sandbox, a mode set
 * in the terminal). Never the saved mode, which may be looser than the source
 * (Bypass): the new session asks before anything until the reader picks.
 */
const UNOFFERED_START_MODE = "manual";

/**
 * Where a handoff's form starts: its source conversation's settings, each
 * kept only while it is valid, else the saved preference for the provider,
 * else its default. The provider must be installed, the model one it lists,
 * the effort one that model takes. The mode is never swapped for a looser one
 * (see `UNOFFERED_START_MODE`). `null` when no provider is installed.
 */
export function handoffStart(source: LaunchSettings, harnesses: HarnessInfo[], models: ModelInfo[], prefs: Prefs = getPrefs()): LaunchSettings | null {
  const installed = (id: string) => harnesses.some((h) => h.id === id && h.available);
  const harness = [source.harness, prefs.lastAgent].find(installed) ?? harnesses.find((h) => h.available)?.id;
  if (!harness) return null;
  const own = harness === source.harness;
  const listed = models.filter((m) => m.harness === harness);
  const model = [own ? source.model : undefined, prefs.lastModel[harness]]
    .map((wanted) => (wanted ? listed.find((m) => m.id === wanted) : undefined))
    .find(Boolean) ?? listed.find((m) => m.isDefault) ?? listed[0];
  // Nothing valid saved: null, so the form shows the model's own default.
  const effort = [own ? source.effort : undefined, prefs.lastEffort[harness]].find((wanted) => !!wanted && !!model?.efforts.includes(wanted)) ?? null;
  const permissionMode = source.permissionMode
    ? (pickerMode(source.permissionMode)?.id ?? UNOFFERED_START_MODE)
    : (pickerMode(prefs.lastMode)?.id ?? DEFAULT_PERMISSION_MODE);
  return { harness, model: model?.id ?? "", effort, permissionMode };
}

/**
 * The same preferences and valid launch choices for every new-session surface.
 * With `controlled`, the choices are the form's own and preferences are only
 * read, for the saved model and effort of an agent switched to.
 */
export function useSessionAgent(harnesses: HarnessInfo[], here = true, modelClient?: WorkspaceRpcClient | null, controlled?: ControlledLaunch) {
  const prefs = usePrefs();
  // The bypass confirmation answers later: it must change the value as it is then.
  const latest = useRef(controlled);
  latest.current = controlled;
  const chosen = controlled?.value;
  const harness = harnesses.find((h) => h.id === (chosen ? chosen.harness : prefs.lastAgent)) ?? harnesses[0] ?? null;
  const catalog = useModels(controlled?.preserveUnavailableModel ? undefined : harness?.id);
  const listed = controlled?.preserveUnavailableModel ? catalog.filter((m) => m.harness === harness?.id) : catalog;
  const picker = usePickerModels(listed, !here, modelClient, harness?.id);
  const models = harness ? picker.models : [];
  const savedModel = harness ? (chosen ? chosen.model : prefs.lastModel[harness.id]) : undefined;
  // A retired model, another provider's id, or a local pin unavailable in the
  // cloud must never reach the launch payload. Keep prefs intact while loading.
  const unavailableModel = controlled?.preserveUnavailableModel && savedModel && !models.some((m) => m.id === savedModel) ? savedModel : null;
  const model = unavailableModel ? null : models.find((m) => m.id === savedModel) ?? models.find((m) => m.isDefault) ?? models[0] ?? null;
  const savedEffort = harness ? (chosen ? chosen.effort : prefs.lastEffort[harness.id]) : undefined;
  const effort = savedEffort && model?.efforts.includes(savedEffort)
    ? savedEffort
    : controlled?.allowDefaultEffort ? null
    : model?.defaultEffort && model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : model?.efforts[0] ?? null;
  const mode = pickerMode(chosen ? chosen.permissionMode : prefs.lastMode)?.id ?? DEFAULT_PERMISSION_MODE;

  const change = (patch: Partial<LaunchSettings>) => {
    const current = latest.current;
    if (current) current.onChange({ ...current.value, ...patch });
  };

  return {
    harnesses,
    harness,
    here,
    models,
    refreshModels: picker.refresh,
    model,
    modelId: unavailableModel ?? model?.id ?? "",
    unavailableModel,
    allowDefaultEffort: controlled?.allowDefaultEffort ?? false,
    effort,
    mode,
    // Like New Session, only explicit choices are persisted, per provider.
    selectHarness: (id: string) => {
      if (!controlled) setPrefs({ lastAgent: id });
      // Another agent starts on its own saved model and effort, as it would on New Session.
      else if (id !== harness?.id) {
        if (!controlled.preserveUnavailableModel) {
          change({ harness: id, model: prefs.lastModel[id] ?? "", effort: prefs.lastEffort[id] ?? null });
          return;
        }
        const available = catalog.filter((m) => m.harness === id);
        const next = available.find((m) => m.id === prefs.lastModel[id]) ?? available.find((m) => m.isDefault) ?? available[0];
        const saved = prefs.lastEffort[id];
        change({ harness: id, model: next?.id ?? "", effort: saved && next?.efforts.includes(saved) ? saved : null });
      }
    },
    selectModel: (id: string) => {
      const next = models.find((m) => m.id === id);
      if (!harness || !next) return;
      if (!controlled) setPrefs({ lastModel: { ...prefs.lastModel, [harness.id]: id } });
      // Only an effort picked here or saved carries over, where the new model takes it; else that model's default applies, as on New Session.
      else change({ model: id, effort: chosen?.effort && next.efforts.includes(chosen.effort) ? chosen.effort : null });
    },
    selectEffort: (value: string) => {
      if (controlled?.allowDefaultEffort && value === "") {
        change({ effort: null });
        return;
      }
      if (!harness || !model?.efforts.includes(value)) return;
      if (!controlled) setPrefs({ lastEffort: { ...prefs.lastEffort, [harness.id]: value } });
      else change({ effort: value });
    },
    // Bypass is confirmed once unless the controlled surface supplies its own warning.
    selectMode: (id: string) => controlled?.bypassWarning ? change({ permissionMode: id }) : chooseMode(harness?.id ?? "", id, (picked) => (latest.current ? change({ permissionMode: picked }) : setPrefs({ lastMode: picked }))),
  };
}
