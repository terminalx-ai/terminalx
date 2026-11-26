import { invoke } from "@/lib/api";

export interface StartupPolicy { suspectAfterSeconds: number; escalateAfterSeconds: number }
export interface StartupRecorderExit {
  finishedAt: number; exitCode: number | null; signal: number | null;
  failure: "spawn" | "wait" | null; osError: number | null;
}
export interface StartupLaunch {
  id: string; pane: string; pid: number | null;
  category: "agent" | "shell" | "validation" | "ownedChild";
  evidence: "readiness" | "smallUnchangingImage";
  phase: "spawning" | "awaitingReady" | "running" | "permissionPrompt" | "exited" | "unobserved";
  startedAt: number; lastProgressAt: number; exitCode: number | null;
  recorderExit?: StartupRecorderExit | null;
}
export interface StartupProbe {
  id: string; startedAt: number; observationTimedOut: boolean;
  shell?: { exitCode: number | null } | null;
  ownerExit?: StartupRecorderExit | null;
  result: null | { finishedAt: number; shell: { exitCode: number | null }; native: { exitCode: number | null } };
}
/** What the incident looked like when its banner was hidden. The owner clears it when the
 * incident gets worse: it escalates, or more panes are affected (PRO-575). */
export interface StartupDismissal { at: number; escalated: boolean; affectedPanes: number }
export interface StartupIncident {
  id: string; detectedAt: number; escalatedAt: number | null; recoveredAt: number | null;
  launches: string[]; blockedPipelines: string[]; probe: StartupProbe | null;
  /** The permission waits holding recovery now: in the incident's panes, or new starts behind a card. */
  recoveryWaits?: string[];
  dismissed?: StartupDismissal | null;
}
export interface StartupSnapshot { policy: StartupPolicy; launches: StartupLaunch[]; incidents: StartupIncident[]; censusIncomplete?: boolean; observationLostAt?: number | null }
export interface StartupPreview { id: string; content: string }

export const startupDiagnostics = {
  status: () => invoke<StartupSnapshot>("startup_diagnostics_status"),
  policy: (policy: StartupPolicy) => invoke<void>("startup_diagnostics_policy", { policy }),
  probe: () => invoke<StartupSnapshot>("startup_diagnostics_probe"),
  dismiss: (incident: string) => invoke<StartupSnapshot>("startup_diagnostics_dismiss", { incident }),
  preview: () => invoke<StartupPreview>("startup_diagnostics_preview"),
  export: (previewId: string, path: string) => invoke<void>("startup_diagnostics_export", { previewId, path }),
};

export const OPEN_STARTUP_DIAGNOSTICS = "open-startup-diagnostics";
export function openStartupDiagnostics() { window.dispatchEvent(new Event(OPEN_STARTUP_DIAGNOSTICS)); }
