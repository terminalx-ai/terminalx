import { invoke } from "@tauri-apps/api/core";

// Compute limits and provider usage for the account's active organization.
// Every member can read the limits; only owners and admins edit them or see
// the usage report. Edits carry both the account contextRevision (refused
// after an account/organization switch) and the policy version (refused if
// another admin changed it first).

export const COMPUTE_PROVIDERS = ["machine0", "box", "hetzner"] as const;
export const IDLE_CAP_OPTIONS = [5, 10, 15, 30, 60] as const;

export interface ComputePolicy {
  version: number;
  maxWorkspaces: number;
  maxRunningWorkspaces: number | null;
  maxIdleSuspendMinutes: number | null;
  allowedMachineClasses: Record<string, string[]>;
  allowedLocations: Record<string, string[]>;
  provisioningPaused: boolean;
  pausedReason: string | null;
  pausedAt: number | null;
  pausedBy: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface ComputeCounts {
  workspaces: number;
  running: number;
}

export interface ComputePolicyView {
  policy: ComputePolicy;
  canEdit: boolean;
  counts: ComputeCounts;
  /** Operator-set upper bound for any organization's workspace limit. */
  workspaceCeiling: number;
  contextRevision: string;
}

export type ComputePolicyEdit = Pick<
  ComputePolicy,
  "maxWorkspaces" | "maxRunningWorkspaces" | "maxIdleSuspendMinutes" | "allowedMachineClasses" | "allowedLocations"
> & { expectedVersion: number };

export type ComputeAlertCode =
  | "provisioning-paused"
  | "workspace-limit-reached"
  | "workspace-limit-near"
  | "running-limit-reached"
  | "running-limit-near"
  | "provider-usage-unavailable"
  | "provider-usage-delayed"
  | "retained-storage-charging"
  | "cleanup-pending"
  | "attention-required"
  | "idle-suspend-disabled";

export interface ComputeAlert {
  code: ComputeAlertCode | string;
  severity: "info" | "warning" | "critical";
  provider?: string;
  workspaceId?: string;
  observedAt?: number;
}

export interface ComputeProviderUsage {
  provider: string;
  currency: string;
  measured: { source: string; runtimeSeconds: number; observedAt: number | null };
  estimate: {
    source: string;
    computeMicros: number;
    retainedStorageMonthlyMicros: number;
    retainedStorageUnpricedCount: number;
    pricingObservedAt: number | null;
  };
  providerReported: {
    status: "unavailable" | "current" | "delayed";
    currency?: string;
    totalMicros?: number;
    periodStart?: number;
    periodEnd?: number;
    providerReportedAt?: number;
    receivedAt?: number;
  };
}

export interface ComputeWorkspaceUsage {
  workspaceId: string;
  name: string;
  provider: string;
  state: string;
  running: boolean;
  currency: string;
  measuredRuntimeSeconds: number;
  estimatedComputeMicros: number;
}

export interface ComputeRetainedResource {
  workspaceId: string;
  name: string;
  provider: string;
  kind: "stopped-disk" | "archived-disk" | "cleanup-pending" | string;
  diskGiB: number | null;
  currency: string;
  estimatedMonthlyMicros: number | null;
  deleteAfter: number | null;
}

export interface ComputeUsageReport {
  generatedAt: number;
  period: { start: number; end: number };
  counts: ComputeCounts;
  providers: ComputeProviderUsage[];
  workspaces: ComputeWorkspaceUsage[];
  retained: ComputeRetainedResource[];
  alerts: ComputeAlert[];
  contextRevision: string;
}

export interface OrganizationComputeError {
  code: string;
  status: number | null;
  retryAfterSeconds: number | null;
}

export const organizationCompute = {
  policy: () => invoke<ComputePolicyView>("organization_compute_policy"),
  usage: () => invoke<ComputeUsageReport>("organization_compute_usage"),
  updatePolicy: (policy: ComputePolicyEdit, contextRevision: string) =>
    invoke<ComputePolicyView>("organization_compute_policy_update", { policy, contextRevision }),
  setProvisioningPaused: (expectedVersion: number, paused: boolean, reason: string | null, contextRevision: string) =>
    invoke<ComputePolicyView>("organization_compute_provisioning_pause", { expectedVersion, paused, reason, contextRevision }),
};

export const PROVIDER_LABEL: Record<string, string> = { machine0: "Machine0", box: "Box", hetzner: "Hetzner" };
export const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;

/** Provider amounts are integer micros of the provider's billing currency. */
export function formatMicros(micros: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(micros / 1_000_000);
  } catch {
    return `${(micros / 1_000_000).toFixed(2)} ${currency}`;
  }
}

export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
}

/** Parses a comma-separated allow list; blank means any. */
export function parseAllowList(text: string): string[] | null {
  const ids = [...new Set(text.split(",").map((id) => id.trim()).filter(Boolean))];
  return ids.length ? ids : null;
}

export function alertMessage(alert: ComputeAlert): string {
  const provider = alert.provider ? providerLabel(alert.provider) : "the provider";
  switch (alert.code) {
    case "provisioning-paused":
      return "New workspaces are paused. Existing workspaces keep running and billing.";
    case "workspace-limit-reached":
      return "The workspace limit is reached. New workspaces are refused until one is archived or deleted.";
    case "workspace-limit-near":
      return "The organization is close to its workspace limit.";
    case "running-limit-reached":
      return "The running limit is reached. New and resumed workspaces are refused until one is suspended.";
    case "running-limit-near":
      return "The organization is close to its running limit.";
    case "provider-usage-unavailable":
      return `${provider} has not reported billing to TerminalX. Figures for it are estimates only.`;
    case "provider-usage-delayed":
      return `${provider}'s billing report is out of date. Spend since then may exceed the estimates shown.`;
    case "retained-storage-charging":
      return "Stopped and archived workspaces keep disks or snapshots that the provider continues to charge for.";
    case "cleanup-pending":
      return `A deleted workspace still has resources at ${provider} that may be charging until cleanup finishes.`;
    case "attention-required":
      return "A workspace needs attention and may still be running on the provider.";
    case "idle-suspend-disabled":
      return "A running workspace never suspends when idle, so it bills continuously.";
    default:
      return "Check cloud compute usage.";
  }
}

export function computeErrorMessage(error: unknown): string {
  const failure = error as Partial<OrganizationComputeError> | null;
  const code = typeof failure?.code === "string" ? failure.code : "";
  switch (code) {
    case "organization_admin_required":
      return "Only organization owners and admins can change compute limits or view usage.";
    case "cloud_compute_policy_conflict":
      return "Another admin changed these limits. The latest limits have been loaded; review them and try again.";
    case "cloud_workspace_request_invalid":
      return "Those limits are not valid. Check the values and try again.";
    case "organization_compute_outcome_unknown":
      return "TerminalX lost the response, so the change may or may not have been applied. The limits have been refreshed; check them before trying again.";
    case "account_context_changed_after_send":
      return "Your account or organization changed while this was saving, so it may have been applied. Check the limits before trying again.";
    case "account_context_changed":
      return "Your account or organization changed. The limits have been refreshed.";
    case "account_signed_out":
      return "Sign in to manage cloud compute.";
    case "account_organization_unavailable":
    case "active_organization_required":
      return "Select an organization to manage its cloud compute.";
    case "cloud_workspace_not_found":
      return "This organization is no longer available.";
    case "invalid_access_token":
      return "Your session expired. Sign in again.";
    default:
      return "TerminalX could not reach the account service. Try again.";
  }
}
