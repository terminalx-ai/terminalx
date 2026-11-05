import { useSyncExternalStore } from "react";
import { agent, type ModelInfo } from "@/lib/api";
import { prettyModelId } from "@terminalx/portable/agentSettings";

// The pickers' models, efforts, modes and pending note are shared with the
// phone, which offers the same choices.
export * from "@terminalx/portable/agentSettings";

let models: ModelInfo[] = [];
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export function loadModels() {
  if (!loading) {
    loading = agent
      .listModels()
      .then((m) => {
        models = m;
        for (const l of listeners) l();
      })
      .catch(() => {});
  }
  return loading;
}

/** Re-read the list from the agents themselves; the picker does this as it opens. */
export async function refreshModels() {
  try {
    models = await agent.listModels(true);
    for (const l of listeners) l();
  } catch {
    /* keep whatever was known */
  }
}

export function useModels(harness?: string): ModelInfo[] {
  const all = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void loadModels();
      return () => listeners.delete(cb);
    },
    () => models,
    () => models,
  );
  return harness ? all.filter((m) => m.harness === harness) : all;
}

export function modelLabel(harness: string, id: string): string {
  const m = models.find((x) => x.harness === harness && x.id === id);
  return m?.label ?? prettyModelId(id);
}

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
