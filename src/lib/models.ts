import { useSyncExternalStore } from "react";
import { agent, type ModelInfo } from "@/lib/api";

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
  return m?.label ?? (id || "Default");
}

export const PERMISSION_MODES: { id: string; label: string; hint: string }[] = [
  { id: "plan", label: "Plan", hint: "Read and plan only; no edits or commands." },
  { id: "manual", label: "Ask every time", hint: "Every edit and command waits for you." },
  { id: "auto", label: "Auto", hint: "Routine actions are approved; risky ones ask." },
  { id: "acceptEdits", label: "Accept edits", hint: "File edits go through; commands still ask." },
  { id: "bypassPermissions", label: "Bypass permissions", hint: "Nothing asks. Only in a tree you can throw away." },
];

export function modeLabel(id: string): string {
  return PERMISSION_MODES.find((m) => m.id === id)?.label ?? "Auto";
}

export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
