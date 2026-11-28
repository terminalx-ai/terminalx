import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { automationsApi } from "@/lib/api";
import type { Automation, AutomationInput, AutomationIssueState, AutomationRun } from "@/types/automations";
import { noteAutomationFailure } from "@/lib/notify";

interface State {
  loaded: boolean;
  automations: Automation[];
  runs: Record<string, AutomationRun[]>;
  loadingRuns: Record<string, boolean>;
  issueStates: Record<string, AutomationIssueState>;
}

let state: State = { loaded: false, automations: [], runs: {}, loadingRuns: {}, issueStates: {} };
const listeners = new Set<() => void>();
const __subscribe_listeners = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const loading = new Map<string, Promise<AutomationRun[]>>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function upsertRun(run: AutomationRun) {
  const current = state.runs[run.automationId] ?? [];
  const previous = current.find((value) => value.runId === run.runId);
  const found = current.some((value) => value.runId === run.runId);
  const next = found ? current.map((value) => (value.runId === run.runId ? run : value)) : [run, ...current];
  next.sort((a, b) => b.runNumber - a.runNumber);
  set({ runs: { ...state.runs, [run.automationId]: next } });
  if (run.status === "failed" && previous?.status !== "failed") {
    const automation = state.automations.find((value) => value.id === run.automationId);
    // A bot's duty reports its own failure, within its bot's quiet hours (`bot_duty_report`, PRO-492).
    if (automation && !automation.bot) noteAutomationFailure(automation.name, run);
  }
}

/** Runs the backend took out of the history, so a late answer cannot bring one back. */
const removedRuns = new Set<string>();

/** A pending run whose first check's result was folded into an earlier record. */
export function removeRun(automationId: string, runId: string) {
  removedRuns.add(runId);
  const current = state.runs[automationId];
  if (!current?.some((value) => value.runId === runId)) return;
  set({ runs: { ...state.runs, [automationId]: current.filter((value) => value.runId !== runId) } });
}

let booted = false;
export async function bootAutomations() {
  if (booted) return;
  booted = true;
  try {
    await Promise.all([
      listen<Automation[]>("automations_changed", (event) => set({ automations: event.payload, loaded: true })),
      listen<AutomationRun>("automation_run", (event) => upsertRun(event.payload)),
      listen<{ automationId: string; runId: string }>("automation_run_removed", (event) => removeRun(event.payload.automationId, event.payload.runId)),
      listen<AutomationIssueState>("automation_issue_state", (event) => {
        const value = event.payload;
        set({ issueStates: { ...state.issueStates, [value.automationId]: value } });
      }),
      // Changes made while the live connection was down were not announced.
      listen("local_runtime_reattached", () => void listAutomations()),
    ]);
  } catch {
    /* outside a webview */
  }
  await listAutomations();
}

async function listAutomations() {
  try {
    const [automations, issueStates] = await Promise.all([automationsApi.list(), automationsApi.issueStates()]);
    set({
      automations,
      issueStates: Object.fromEntries(issueStates.map((value) => [value.automationId, value])),
      loaded: true,
    });
  } catch {
    set({ loaded: true });
  }
}

export function useAutomationStore(): State {
  return useSyncExternalStore(
    __subscribe_listeners,
    () => state,
    () => state,
  );
}

export function getAutomationStore(): State {
  return state;
}

export async function refreshAutomations() {
  const [automations, issueStates] = await Promise.all([automationsApi.list(), automationsApi.issueStates()]);
  set({
    automations,
    issueStates: Object.fromEntries(issueStates.map((value) => [value.automationId, value])),
    loaded: true,
  });
}

export function loadAutomationRuns(automationId: string): Promise<AutomationRun[]> {
  const pending = loading.get(automationId);
  if (pending) return pending;
  set({ loadingRuns: { ...state.loadingRuns, [automationId]: true } });
  const request = automationsApi
    .runs(automationId)
    .then((runs) => {
      set({ runs: { ...state.runs, [automationId]: runs } });
      return runs;
    })
    .finally(() => {
      loading.delete(automationId);
      set({ loadingRuns: { ...state.loadingRuns, [automationId]: false } });
    });
  loading.set(automationId, request);
  return request;
}

export async function createAutomation(input: AutomationInput) {
  const automation = await automationsApi.create(input);
  const exists = state.automations.some((value) => value.id === automation.id);
  set({ automations: exists ? state.automations.map((value) => (value.id === automation.id ? automation : value)) : [...state.automations, automation] });
  return automation;
}

export async function updateAutomation(id: string, input: AutomationInput) {
  const automation = await automationsApi.update(id, input);
  set({ automations: state.automations.map((value) => (value.id === id ? automation : value)) });
  return automation;
}

export async function deleteAutomation(id: string) {
  await automationsApi.remove(id);
  const runs = { ...state.runs };
  const issueStates = { ...state.issueStates };
  delete runs[id];
  delete issueStates[id];
  set({ automations: state.automations.filter((value) => value.id !== id), runs, issueStates });
}

export async function runAutomationNow(id: string) {
  const run = await automationsApi.runNow(id);
  // The run's own events may have arrived first (a quick first check): the
  // pending run returned here must not replace its outcome or come back.
  const known = state.runs[run.automationId]?.some((value) => value.runId === run.runId);
  if (!known && !removedRuns.has(run.runId)) upsertRun(run);
  return run;
}

if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
