import { useState } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { chooseMode } from "@/lib/dialogs";
import { DEFAULT_PERMISSION_MODE, pickerMode, useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { setPrefs, usePrefs } from "@/lib/prefs";
import type { HarnessInfo, TabEntry } from "@/types/session";

/** What a new agent conversation is launched with. */
export interface LaunchSettings {
  harness: string;
  model: string;
  effort: string | null;
  permissionMode: string;
}

/** A tab's settings as the start of another launch: what it was last asked to run, pending or not. */
export function launchSettingsOf(tab: TabEntry): LaunchSettings {
  return {
    harness: tab.harness,
    model: tab.requestedModel || tab.model,
    effort: tab.requestedEffort ?? tab.effort ?? null,
    permissionMode: tab.requestedPermissionMode || tab.permissionMode,
  };
}

interface Picked {
  harness?: string;
  model: Record<string, string>;
  effort: Record<string, string>;
  permissionMode?: string;
}

/**
 * The same preferences and valid launch choices for every new-session surface.
 *
 * `start` is where a surface begins other than the saved preferences (a
 * handoff starts from its source conversation), and each of its values counts
 * only while it is valid: an installed provider, a model that provider lists,
 * an effort that model takes, a mode the picker offers. Its model and effort
 * belong to its provider, so switching to another provider falls back to that
 * one's preferences, and switching back finds them again.
 *
 * A choice made here is saved as the preference for the next launch on every
 * surface alike. A surface with a `start` also keeps its own picks over it.
 */
export function useSessionAgent(harnesses: HarnessInfo[], here = true, modelClient?: WorkspaceRpcClient | null, start?: LaunchSettings) {
  const prefs = usePrefs();
  const [picked, setPicked] = useState<Picked>({ model: {}, effort: {} });
  const offered = (id?: string) => harnesses.find((h) => h.id === id && (!here || h.available));
  const harness = start
    ? (offered(picked.harness) ?? offered(start.harness) ?? offered(prefs.lastAgent) ?? harnesses.find((h) => !here || h.available) ?? null)
    : (harnesses.find((h) => h.id === prefs.lastAgent) ?? harnesses[0] ?? null);
  const listed = useModels(harness?.id);
  const picker = usePickerModels(listed, !here, modelClient, harness?.id);
  const models = harness ? picker.models : [];
  const id = harness?.id ?? "";
  const begun = start?.harness === id ? start : undefined;
  // A retired model, another provider's id, or a local pin unavailable in the
  // cloud must never reach the launch payload. Keep prefs intact while loading.
  const model = [picked.model[id], begun?.model, prefs.lastModel[id]]
    .map((wanted) => (wanted ? models.find((m) => m.id === wanted) : undefined))
    .find(Boolean) ?? models.find((m) => m.isDefault) ?? models[0] ?? null;
  const effort = [picked.effort[id], begun?.effort, prefs.lastEffort[id], model?.defaultEffort]
    .find((wanted) => !!wanted && !!model?.efforts.includes(wanted)) ?? model?.efforts[0] ?? null;
  const permissionMode = [picked.permissionMode, start?.permissionMode, prefs.lastMode]
    .map((wanted) => (wanted ? pickerMode(wanted)?.id : undefined))
    .find(Boolean) ?? DEFAULT_PERMISSION_MODE;
  const keep = (patch: (current: Picked) => Picked) => {
    if (start) setPicked(patch);
  };

  return {
    harnesses,
    harness,
    here,
    models,
    refreshModels: picker.refresh,
    model,
    modelId: model?.id ?? "",
    effort,
    permissionMode,
    settings: harness ? { harness: harness.id, model: model?.id ?? "", effort, permissionMode } : null,
    // Like New Session, only explicit choices are persisted, per provider.
    selectHarness: (next: string) => {
      setPrefs({ lastAgent: next });
      keep((current) => ({ ...current, harness: next }));
    },
    selectModel: (next: string) => {
      if (harness && models.some((m) => m.id === next)) {
        setPrefs({ lastModel: { ...prefs.lastModel, [harness.id]: next } });
        keep((current) => ({ ...current, model: { ...current.model, [harness.id]: next } }));
      }
    },
    selectEffort: (next: string) => {
      if (harness && model?.efforts.includes(next)) {
        setPrefs({ lastEffort: { ...prefs.lastEffort, [harness.id]: next } });
        keep((current) => ({ ...current, effort: { ...current.effort, [harness.id]: next } }));
      }
    },
    // Bypass asks first, the same everywhere; the mode lands once it is agreed to.
    selectMode: (next: string) => chooseMode(id, next, (mode) => {
      setPrefs({ lastMode: mode });
      keep((current) => ({ ...current, permissionMode: mode }));
    }),
  };
}
