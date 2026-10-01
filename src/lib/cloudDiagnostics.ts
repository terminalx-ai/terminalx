import { formatDuration as formatElapsed } from "@/lib/time";

// Cloud diagnostics (PRO-38): the organization's recent cloud operations,
// create/resume stage timings and relay close reasons, for owners and
// administrators, plus the typed relay closes this desktop met. The Rust
// side fetches and exports; nothing here writes to disk.

export const DIAGNOSTICS_WINDOW_OPTIONS = [1, 7, 14, 30] as const;
export const DEFAULT_DIAGNOSTICS_WINDOW_DAYS = 7;

export interface DiagnosticsPercentiles {
  p50: number | null;
  p95: number | null;
}

export interface DiagnosticsStageTiming extends DiagnosticsPercentiles {
  samples: number;
}

export interface DiagnosticsOperationTimings {
  samples: number;
  totalMs: DiagnosticsPercentiles;
  stages: Record<string, DiagnosticsStageTiming>;
}

export interface DiagnosticsRestartDecision {
  path: string;
  reason: string | null;
  decidedAt?: number | null;
  fencedAt: number | null;
  replacedRuntimeGeneration: number | null;
  fence: string | null;
}

export interface DiagnosticsHistoryEntry {
  state: string;
  stage: string | null;
  errorCode: string | null;
  detailCode: string | null;
  at: number;
}

export interface DiagnosticsOperation {
  operationId: string;
  workspaceId: string;
  provider: string | null;
  type: string;
  state: string;
  stage: string | null;
  errorCode: string | null;
  retryAction: string | null;
  attemptCount: number | null;
  createdAt: number;
  updatedAt: number;
  durationMs: number | null;
  restartDecision: DiagnosticsRestartDecision | null;
  history: DiagnosticsHistoryEntry[];
}

export interface DiagnosticsWorkspace {
  workspaceId: string;
  provider: string | null;
  state: string;
  runtimeGeneration: number | null;
  lastActivityAt: number | null;
  activityReportedAt?: number | null;
  activeTurns?: number | null;
  pendingApprovals?: number | null;
  oomRelaunchCount?: number | null;
  connections: { ready: number; waitingForRuntime: number; expired: number };
  lastOperationId: string | null;
}

export interface DiagnosticsCloseReason {
  code: number;
  name: string;
  retryAction: string | null;
}

export interface CloudDiagnostics {
  v: number;
  organizationId: string;
  generatedAt: number;
  window: { from: number; to: number; maxOperations: number | null; truncated: boolean };
  retention: { operationHistoryDays: number | null; operationLogDays: number | null } | null;
  stageTimings: { create: DiagnosticsOperationTimings | null; resume: DiagnosticsOperationTimings | null };
  operations: DiagnosticsOperation[];
  workspaces: DiagnosticsWorkspace[];
  closeReasons: DiagnosticsCloseReason[];
}

/** A typed relay close (4100-4104) this desktop met; memory only. */
export interface ConnectionClose {
  workspaceId: string | null;
  code: number;
  name: string;
  at: number;
}

const RETRY_HINTS: Record<string, string> = {
  none: "No action needed.",
  wait: "Still running — wait for it to finish.",
  "retry-operation": "Retry the operation.",
  "retry-resume": "Retry resuming the workspace.",
  "retry-delete": "Retry deleting the workspace.",
  "retry-later": "The provider is busy or unavailable — retry later.",
  "fix-provider-credentials": "Validate or replace the provider key in Provider settings, then retry.",
  "reconcile-provider": "Check the provider console; the resource state needs reconciling.",
  "connect-agent-credential": "Connect the agent credential for this workspace, then retry.",
  "update-app": "Update TerminalX, then retry.",
  "resume-or-delete": "Resume the workspace or delete it.",
  "recheck-readiness": "Reconnect after the runtime reports ready; the app retries on its own.",
  "fetch-new-ticket": "The app fetches a new ticket and reconnects on its own.",
  "reconnect-with-resume-credential": "The app reconnects with its resume credential on its own.",
};

export function retryHint(action: string | null | undefined): string {
  if (!action) return "";
  return RETRY_HINTS[action] ?? `Suggested action: ${action}.`;
}

export function diagnosticsErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  switch (code) {
    case "organization_admin_required":
      return "Only organization owners and administrators can view cloud diagnostics.";
    case "cloud_workspace_not_found":
    case "cloud_organization_unavailable":
      return "Cloud diagnostics are not available for this organization from this account.";
    case "cloud_diagnostics_not_supported":
      return "Cloud diagnostics are not available on this server yet.";
    case "account_signed_out":
    case "account_organization_unavailable":
      return "Sign in and choose an organization to view cloud diagnostics.";
    case "account_context_changed":
      return "The account or organization changed. Refresh before trying again.";
    default:
      return "Cloud diagnostics could not be loaded. Refresh to try again.";
  }
}

export function exportErrorMessage(error: unknown): string {
  const code = typeof error === "string" ? error : "";
  switch (code) {
    case "cloud_diagnostics_export_path_invalid":
      return "Choose a location on this Mac for the export.";
    case "cloud_diagnostics_export_write_failed":
      return "The file could not be written there. Choose another location.";
    default:
      return "The export could not be saved.";
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatElapsed(ms);
}
