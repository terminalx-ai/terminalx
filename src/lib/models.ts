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

/**
 * A readable name for an id the list no longer carries — a session stored
 * before a model was retired, say. `gpt-5.6-sol` reads as `GPT-5.6 Sol`.
 */
export function prettyModelId(id: string): string {
  if (!id) return "Default";
  const last = id.split("/").pop() ?? id;
  return last
    .replace(/^gpt/i, "GPT")
    .replace(/(\d)-([a-z])/gi, "$1 $2")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * How a model being retired reads in the picker: the replacement's own label,
 * shown faintly after the name. `null` when the model is current.
 */
export function upgradeHint(m: ModelInfo, all: ModelInfo[]): string | null {
  if (!m.upgrade) return null;
  return all.find((x) => x.id === m.upgrade)?.label ?? prettyModelId(m.upgrade);
}

export function modelLabel(harness: string, id: string): string {
  const m = models.find((x) => x.harness === harness && x.id === id);
  return m?.label ?? prettyModelId(id);
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

export const BYPASS_MODE = "bypassPermissions";

/**
 * What "Bypass permissions" comes down to for one agent: the flag its CLI is
 * launched with, and what that flag stops doing. The hint in the picker is
 * one line; this is what the reader is asked to agree to, so it says which
 * protections are gone rather than that some are.
 */
export function bypassEffect(harness: string): { flag: string; effect: string } {
  if (harness === "codex") {
    return {
      flag: "--dangerously-bypass-approvals-and-sandbox",
      effect:
        "Codex runs with its sandbox off and its approvals off. Every command it writes executes immediately, with your own access to the disk and the network, and nothing stops to ask — not for edits outside this workspace, not for deletions, not for anything that reaches the internet.",
    };
  }
  if (harness === "claude") {
    return {
      flag: "--permission-mode bypassPermissions",
      effect:
        "Claude Code stops asking about anything. File edits, shell commands and network calls all go through the moment it decides on them, inside this workspace and out.",
    };
  }
  return {
    flag: BYPASS_MODE,
    effect: "The agent stops asking about anything. Every edit and every command it decides on runs the moment it decides on it.",
  };
}

export const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

// Module state lives here; a hot update would lose it, so edits reload the page.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
