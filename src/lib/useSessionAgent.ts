import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { setPrefs, usePrefs } from "@/lib/prefs";
import type { HarnessInfo } from "@/types/session";

/** The same preferences and valid launch choices for every new-session surface. */
export function useSessionAgent(harnesses: HarnessInfo[], here = true, modelClient?: WorkspaceRpcClient | null) {
  const prefs = usePrefs();
  const harness = harnesses.find((h) => h.id === prefs.lastAgent) ?? harnesses[0] ?? null;
  const listed = useModels(harness?.id);
  const picker = usePickerModels(listed, !here, modelClient, harness?.id);
  const models = harness ? picker.models : [];
  const savedModel = harness ? prefs.lastModel[harness.id] : undefined;
  // A retired model, another provider's id, or a local pin unavailable in the
  // cloud must never reach the launch payload. Keep prefs intact while loading.
  const model = models.find((m) => m.id === savedModel) ?? models.find((m) => m.isDefault) ?? models[0] ?? null;
  const savedEffort = harness ? prefs.lastEffort[harness.id] : undefined;
  const effort = savedEffort && model?.efforts.includes(savedEffort)
    ? savedEffort
    : model?.defaultEffort && model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort
      : model?.efforts[0] ?? null;

  return {
    harnesses,
    harness,
    here,
    models,
    refreshModels: picker.refresh,
    model,
    modelId: model?.id ?? "",
    effort,
    // Like New Session, only explicit choices are persisted, per provider.
    selectHarness: (id: string) => setPrefs({ lastAgent: id }),
    selectModel: (id: string) => {
      if (harness && models.some((m) => m.id === id)) {
        setPrefs({ lastModel: { ...prefs.lastModel, [harness.id]: id } });
      }
    },
    selectEffort: (value: string) => {
      if (harness && model?.efforts.includes(value)) {
        setPrefs({ lastEffort: { ...prefs.lastEffort, [harness.id]: value } });
      }
    },
  };
}
