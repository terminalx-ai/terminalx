import { invoke } from "@tauri-apps/api/core";
import { cloudProviderLabel } from "@/lib/cloudProviders";

// Compute limits and provider usage for the account's active organization.
// Every member can read the limits; only owners and admins edit them or see
// the usage report. Edits carry both the account contextRevision (refused
// after an account/organization switch) and the policy version (refused if
// another admin changed it first).

export const IDLE_CAP_OPTIONS = [5, 10, 15, 30, 60] as const;

// A limit that is null is no limit (PRO-371): an organization is held to a
// number only where its admin set one, or where the operator of the service
// set one for everybody (the ceilings and defaults on the view).
export interface ComputePolicy {
  version: number;
  /** How many workspaces the organization may keep. Null: no limit. A server before PRO-371 always sends a number. */
  maxWorkspaces: number | null;
  /** How many may run at once. Null: no limit of its own; the operator's cap (`runningWorkspaceCeiling`), if any, still applies. */
  maxRunningWorkspaces: number | null;
  /**
   * How many running workspaces one person's own creations may hold (PRO-73).
   * Null: no limit per person, only the organization's running limit applies.
   * Undefined: the server does not have the setting, so it is neither shown
   * nor sent.
   */
  maxRunningWorkspacesPerMember?: number | null;
  /**
   * How many workspaces one person may create in an hour and in a day
   * (PRO-73), whatever became of them. Null: the operator's default
   * (`createBudgetDefaults`), and no limit where the operator set none.
   * Undefined: the server does not have the setting.
   */
  maxCreatesPerMemberPerHour?: number | null;
  maxCreatesPerMemberPerDay?: number | null;
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
  /**
   * The most a server before PRO-371 takes for the workspace limit, which it
   * also requires. Null since PRO-371: any number is taken, and none at all.
   * A number here is how the form knows it is talking to the older server.
   */
  workspaceCeiling: number | null;
  /**
   * The server said, with a `workspaceCeiling` of null, that it takes an
   * empty workspace limit (PRO-371). A save to it carries `noLimitAware`. An
   * older server never sends that null, and refuses a key it does not know.
   */
  noLimitAware: boolean;
  /**
   * The operator's cap on running workspaces (saas PRO-76). Null where the
   * operator set none (PRO-371), and from a server before PRO-76, where a
   * blank running limit meant "up to the workspace limit".
   */
  runningWorkspaceCeiling: number | null;
  /**
   * The operator's create budgets, which apply where the policy sets none
   * (PRO-73). Each is null where the operator set none, which is no limit
   * (PRO-371). The whole is null from a server that does not report them.
   */
  createBudgetDefaults: { perHour: number | null; perDay: number | null } | null;
  contextRevision: string;
}

export type ComputePolicyEdit = Pick<
  ComputePolicy,
  "maxWorkspaces" | "maxRunningWorkspaces" | "maxIdleSuspendMinutes" | "allowedMachineClasses" | "allowedLocations"
> & {
  expectedVersion: number;
  maxRunningWorkspacesPerMember?: number | null;
  maxCreatesPerMemberPerHour?: number | null;
  maxCreatesPerMemberPerDay?: number | null;
  /**
   * Marks a save from a desktop that reads a null `maxWorkspaces` as no limit
   * (PRO-371). One from before it showed that null as 1 and saved the 1 back,
   * so the server ignores a 1 sent without this over a stored null: with it,
   * a limit of 1 is saved as typed. Sent only when the view is `noLimitAware`.
   */
  noLimitAware?: true;
};

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

const malformed = (): OrganizationComputeError => ({ code: "organization_compute_unavailable", status: null, retryAfterSeconds: null });
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const allowList = (value: unknown): Record<string, string[]> =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([provider, ids]) =>
          Array.isArray(ids) ? [[provider, ids.filter((id): id is string => typeof id === "string")]] : [],
        ),
      )
    : {};
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

// The native layer forwards the server's JSON as-is; anything a different
// server build leaves out is defaulted here, and a payload without the core
// fields becomes an ordinary "unavailable" error instead of a render crash.
export function normalizePolicyView(value: unknown): ComputePolicyView {
  if (!isObject(value) || !isObject(value.policy) || !isObject(value.counts) || typeof value.policy.version !== "number") throw malformed();
  const policy = value.policy;
  const number = (field: unknown) => (typeof field === "number" ? field : null);
  return {
    policy: {
      version: policy.version as number,
      maxWorkspaces: number(policy.maxWorkspaces),
      maxRunningWorkspaces: number(policy.maxRunningWorkspaces),
      ...("maxRunningWorkspacesPerMember" in policy ? { maxRunningWorkspacesPerMember: number(policy.maxRunningWorkspacesPerMember) } : {}),
      ...("maxCreatesPerMemberPerHour" in policy ? { maxCreatesPerMemberPerHour: number(policy.maxCreatesPerMemberPerHour) } : {}),
      ...("maxCreatesPerMemberPerDay" in policy ? { maxCreatesPerMemberPerDay: number(policy.maxCreatesPerMemberPerDay) } : {}),
      maxIdleSuspendMinutes: number(policy.maxIdleSuspendMinutes),
      allowedMachineClasses: allowList(policy.allowedMachineClasses),
      allowedLocations: allowList(policy.allowedLocations),
      provisioningPaused: policy.provisioningPaused === true,
      pausedReason: typeof policy.pausedReason === "string" ? policy.pausedReason : null,
      pausedAt: number(policy.pausedAt),
      pausedBy: typeof policy.pausedBy === "string" ? policy.pausedBy : null,
      updatedBy: typeof policy.updatedBy === "string" ? policy.updatedBy : null,
      updatedAt: number(policy.updatedAt),
    },
    canEdit: value.canEdit === true,
    counts: { workspaces: number(value.counts.workspaces) ?? 0, running: number(value.counts.running) ?? 0 },
    // Null is the server's own word for "no ceiling" (PRO-371). A server from
    // before it reported one leaves the key out, and is held to the limit it has.
    workspaceCeiling: "workspaceCeiling" in value ? number(value.workspaceCeiling) : number(policy.maxWorkspaces),
    // Only the server's own null: a key left out, or one of another shape, is not that word.
    noLimitAware: value.workspaceCeiling === null,
    runningWorkspaceCeiling: number(value.runningWorkspaceCeiling),
    createBudgetDefaults: isObject(value.createBudgetDefaults)
      ? { perHour: number(value.createBudgetDefaults.perHour), perDay: number(value.createBudgetDefaults.perDay) }
      : null,
    contextRevision: typeof value.contextRevision === "string" ? value.contextRevision : "",
  };
}

export function normalizeUsageReport(value: unknown): ComputeUsageReport {
  if (!isObject(value) || !isObject(value.period) || typeof value.period.start !== "number") throw malformed();
  const providers = list<ComputeProviderUsage>(value.providers).filter(
    (provider) => isObject(provider) && isObject(provider.measured) && isObject(provider.estimate) && isObject(provider.providerReported),
  );
  return {
    generatedAt: typeof value.generatedAt === "number" ? value.generatedAt : Date.now(),
    period: { start: value.period.start, end: typeof value.period.end === "number" ? value.period.end : Date.now() },
    counts: isObject(value.counts) ? (value.counts as unknown as ComputeCounts) : { workspaces: 0, running: 0 },
    providers,
    workspaces: list<ComputeWorkspaceUsage>(value.workspaces),
    retained: list<ComputeRetainedResource>(value.retained).filter(isObject),
    alerts: list<ComputeAlert>(value.alerts).filter(isObject),
    contextRevision: typeof value.contextRevision === "string" ? value.contextRevision : "",
  };
}

export const organizationCompute = {
  policy: () => invoke<unknown>("organization_compute_policy").then(normalizePolicyView),
  usage: () => invoke<unknown>("organization_compute_usage").then(normalizeUsageReport),
  updatePolicy: (policy: ComputePolicyEdit, contextRevision: string) =>
    invoke<unknown>("organization_compute_policy_update", { policy, contextRevision }).then(normalizePolicyView),
  setProvisioningPaused: (expectedVersion: number, paused: boolean, reason: string | null, contextRevision: string) =>
    invoke<unknown>("organization_compute_provisioning_pause", { expectedVersion, paused, reason, contextRevision }).then(normalizePolicyView),
};

/** A provider's name, from its descriptor (PRO-415). */
export const providerLabel = (provider: string) => cloudProviderLabel(provider);

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

/** The smallest of the limits that are set, or null where none is. */
const least = (...limits: (number | null | undefined)[]): number | null => {
  const set = limits.filter((limit): limit is number => typeof limit === "number");
  return set.length ? Math.min(...set) : null;
};

type LimitView = Pick<ComputePolicyView, "policy" | "workspaceCeiling" | "runningWorkspaceCeiling">;

/** The workspace limit that applies, or null where there is none: the organization's own, never above an older server's ceiling. */
export function effectiveWorkspaceLimit(view: Pick<LimitView, "policy" | "workspaceCeiling">): number | null {
  return least(view.policy.maxWorkspaces, view.workspaceCeiling);
}

/**
 * The running limit that applies, or null where there is none: the
 * organization's own, else the operator's cap, never above that cap or the
 * workspace limit. With neither, there is no running limit (PRO-371), except
 * on a server before PRO-76, where a blank limit means the workspace limit.
 */
export function effectiveRunningLimit(view: LimitView): number | null {
  const running = least(view.policy.maxRunningWorkspaces, view.runningWorkspaceCeiling);
  const total = effectiveWorkspaceLimit(view);
  if (running === null) return view.workspaceCeiling === null ? null : total;
  return least(running, total);
}

/** "3 of 5" against a limit; "3, no limit" where there is none. */
export function usageText(used: number, limit: number | null): string {
  return limit === null ? `${used}, no limit` : `${used} of ${limit}`;
}

/**
 * How many workspaces one person may create, in words, from the budgets that
 * apply (the organization's, else the operator's). Null where neither an
 * hour nor a day is limited: there is nothing to tell.
 */
export function createBudgetSentence(perHour: number | null, perDay: number | null): string | null {
  const workspaces = (count: number) => `${count} workspace${count === 1 ? "" : "s"}`;
  if (perHour !== null && perDay !== null) return `Each person can create ${workspaces(perHour)} an hour and ${perDay} a day.`;
  if (perHour !== null) return `Each person can create ${workspaces(perHour)} an hour.`;
  if (perDay !== null) return `Each person can create ${workspaces(perDay)} a day.`;
  return null;
}

/**
 * The largest number a limit can hold: the server keeps each in a 32-bit
 * integer column and refuses anything above it. A bound of storage, not a
 * policy: no organization is expected to come near it.
 */
export const LIMIT_MAX = 2_147_483_647;

/** The limit fields of the form, as typed. */
export interface LimitsText {
  maxWorkspaces: string;
  maxRunningWorkspaces: string;
  perMember: string;
  createsPerHour: string;
  createsPerDay: string;
}

export type LimitField = keyof LimitsText;

export const LIMIT_LABEL: Record<LimitField, string> = {
  maxWorkspaces: "Workspaces",
  maxRunningWorkspaces: "Running at once",
  perMember: "Running per person",
  createsPerHour: "New per person, per hour",
  createsPerDay: "New per person, per day",
};

export interface LimitsCheck {
  /** What each field saves as: its number, or null for no limit. Only to be sent when there are no problems. */
  values: Record<LimitField, number | null>;
  /** Why the limits cannot be saved, one sentence each, with the fields it is about. */
  problems: { fields: LimitField[]; message: string }[];
}

/**
 * Reads the limit fields. A blank field is no limit. A number is refused only
 * for not being a whole number of 1 or more (or one too large to store), and
 * two limits are compared only where both are set (PRO-371).
 *
 * A server before PRO-371 says so with a `workspaceCeiling`: it needs a
 * workspace limit, and takes none above that ceiling.
 */
export function checkLimits(text: LimitsText, view: Pick<ComputePolicyView, "workspaceCeiling" | "runningWorkspaceCeiling">): LimitsCheck {
  const values = { maxWorkspaces: null, maxRunningWorkspaces: null, perMember: null, createsPerHour: null, createsPerDay: null } as Record<LimitField, number | null>;
  const problems: LimitsCheck["problems"] = [];
  const refuse = (fields: LimitField[], message: string) => problems.push({ fields, message });

  // The older server's one rule for the workspace limit, in its one sentence.
  const ceiling = view.workspaceCeiling;
  const withinCeiling = `Workspaces must be a whole number from 1 to ${ceiling}, the most this TerminalX service allows.`;

  for (const field of Object.keys(values) as LimitField[]) {
    const typed = text[field].trim();
    if (!typed) continue;
    // Digits only: "1e3", "0x10", "2.5" and "-1" are not whole numbers of 1 or more.
    const value = /^[0-9]+$/.test(typed) ? Number(typed) : 0;
    if (field === "maxWorkspaces" && ceiling !== null && (value < 1 || value > ceiling)) refuse([field], withinCeiling);
    else if (value < 1) refuse([field], `${LIMIT_LABEL[field]} must be a whole number of 1 or more, or blank for no limit.`);
    else if (value > LIMIT_MAX) refuse([field], `${LIMIT_LABEL[field]} is too large to store. The most is ${LIMIT_MAX}.`);
    else values[field] = value;
  }

  const { maxWorkspaces, maxRunningWorkspaces, perMember, createsPerHour, createsPerDay } = values;
  if (ceiling !== null && !text.maxWorkspaces.trim()) refuse(["maxWorkspaces"], withinCeiling);
  if (maxRunningWorkspaces !== null && maxWorkspaces !== null && maxRunningWorkspaces > maxWorkspaces) {
    refuse(["maxRunningWorkspaces"], "Running at once must be no larger than the workspace limit.");
  } else if (maxRunningWorkspaces !== null && view.runningWorkspaceCeiling !== null && maxRunningWorkspaces > view.runningWorkspaceCeiling) {
    refuse(["maxRunningWorkspaces"], `Running at once must be no larger than ${view.runningWorkspaceCeiling}, the most this TerminalX service allows.`);
  }
  if (perMember !== null && maxWorkspaces !== null && perMember > maxWorkspaces) {
    refuse(["perMember"], "Running per person must be no larger than the workspace limit.");
  }
  if (createsPerHour !== null && createsPerDay !== null && createsPerHour > createsPerDay) {
    refuse(["createsPerHour", "createsPerDay"], "New per person, per hour must be no larger than per day.");
  }
  return { values, problems };
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
    case "cloud_compute_running_limit_above_ceiling":
      return "The running limit is above what this server allows. Choose a lower number.";
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
