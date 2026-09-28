import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  COMPUTE_PROVIDERS,
  IDLE_CAP_OPTIONS,
  alertMessage,
  computeErrorMessage,
  formatHours,
  formatMicros,
  organizationCompute,
  parseAllowList,
  providerLabel,
  type ComputePolicy,
  type ComputePolicyView,
  type ComputeProviderUsage,
  type ComputeUsageReport,
} from "@/lib/organizationCompute";

const inputClass = "h-7 rounded-md border border-hairline bg-background px-2 text-xs disabled:opacity-60";

interface LimitsDraft {
  maxWorkspaces: string;
  maxRunningWorkspaces: string;
  maxIdleSuspendMinutes: string;
  machineClasses: Record<string, string>;
  locations: Record<string, string>;
}

const draftFrom = (policy: ComputePolicy): LimitsDraft => ({
  maxWorkspaces: String(policy.maxWorkspaces),
  maxRunningWorkspaces: policy.maxRunningWorkspaces === null ? "" : String(policy.maxRunningWorkspaces),
  maxIdleSuspendMinutes: policy.maxIdleSuspendMinutes === null ? "" : String(policy.maxIdleSuspendMinutes),
  machineClasses: Object.fromEntries(COMPUTE_PROVIDERS.map((provider) => [provider, (policy.allowedMachineClasses[provider] ?? []).join(", ")])),
  locations: Object.fromEntries(COMPUTE_PROVIDERS.map((provider) => [provider, (policy.allowedLocations[provider] ?? []).join(", ")])),
});

const limitValue = (text: string, ceiling: number): number | null => {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 && value <= ceiling ? value : null;
};

// Providers this build does not edit keep whatever the server holds for them.
const allowLists = (texts: Record<string, string>, stored: Record<string, string[]>): Record<string, string[]> => ({
  ...Object.fromEntries(Object.entries(stored).filter(([provider]) => !(COMPUTE_PROVIDERS as readonly string[]).includes(provider))),
  ...Object.fromEntries(
    Object.entries(texts).flatMap(([provider, text]) => {
      const ids = parseAllowList(text);
      return ids ? [[provider, ids]] : [];
    }),
  ),
});

const formatTime = (timestamp: number | null | undefined) => (timestamp ? new Date(timestamp).toLocaleString() : "never");

export function OrganizationCompute({ contextRevision }: { contextRevision: string }) {
  const [view, setView] = useState<ComputePolicyView | null>(null);
  const [usage, setUsage] = useState<ComputeUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<LimitsDraft | null>(null);
  // Unsaved limit edits survive refreshes and pause toggles.
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState("");
  const contextEpoch = useRef(0);
  const loadSeq = useRef(0);

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const loadUsage = useCallback(async (fresh: () => boolean) => {
    try {
      const report = await organizationCompute.usage();
      if (fresh()) {
        setUsage(report);
        setUsageError(null);
      }
    } catch (failure) {
      if (fresh()) setUsageError(computeErrorMessage(failure));
    }
  }, []);

  const load = useCallback(async (keepError = false) => {
    const current = ++loadSeq.current;
    const context = contextEpoch.current;
    const fresh = () => current === loadSeq.current && context === contextEpoch.current;
    setLoading(true);
    try {
      const next = await organizationCompute.policy();
      if (!fresh()) return;
      setView(next);
      setDraft((current) => (current && dirtyRef.current ? current : draftFrom(next.policy)));
      if (!keepError) setError(null);
      if (next.canEdit) await loadUsage(fresh);
      else setUsage(null);
    } catch (failure) {
      if (fresh()) setError(computeErrorMessage(failure));
    } finally {
      if (fresh()) setLoading(false);
    }
  }, [loadUsage]);

  useEffect(() => {
    setView(null);
    setUsage(null);
    setUsageError(null);
    setDraft(null);
    setDirty(false);
    setBusy(null);
    setError(null);
    void load();
    return () => {
      contextEpoch.current += 1;
    };
  }, [contextRevision, load]);

  const mutate = async (key: string, run: (current: ComputePolicyView) => Promise<ComputePolicyView>): Promise<boolean> => {
    if (!view || busy) return false;
    const context = contextEpoch.current;
    setBusy(key);
    setError(null);
    try {
      const next = await run(view);
      if (context !== contextEpoch.current) return false;
      // Newer than any policy read still in flight; retire those reads.
      const current = ++loadSeq.current;
      setLoading(false);
      setView(next);
      if (key === "limits" || !dirtyRef.current) {
        setDraft(draftFrom(next.policy));
        setDirty(false);
      }
      // Alerts depend on the new policy; only the usage report needs a re-read.
      if (next.canEdit) void loadUsage(() => current === loadSeq.current && context === contextEpoch.current);
      return true;
    } catch (failure) {
      if (context !== contextEpoch.current) return false;
      setError(computeErrorMessage(failure));
      void load(true);
      return false;
    } finally {
      if (context === contextEpoch.current) setBusy(null);
    }
  };

  if (!view || !draft) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        <div className="text-sm font-medium">Cloud compute</div>
        {loading ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading compute limits…
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <p className="text-xs text-destructive">{error}</p>
            <Button variant="ghost" size="xs" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  const { policy, counts, canEdit } = view;
  const ceiling = view.workspaceCeiling;
  const maxWorkspaces = limitValue(draft.maxWorkspaces, ceiling);
  const runningText = draft.maxRunningWorkspaces.trim();
  const maxRunning = runningText ? limitValue(runningText, ceiling) : null;
  const runningInvalid = Boolean(runningText) && (maxRunning === null || (maxWorkspaces !== null && maxRunning > maxWorkspaces));
  const limitsInvalid = maxWorkspaces === null || runningInvalid;
  // The paused banner already says this.
  const alerts = (usage?.alerts ?? []).filter((alert) => alert.code !== "provisioning-paused");
  const idleOptions = [...new Set([...IDLE_CAP_OPTIONS, ...(policy.maxIdleSuspendMinutes === null ? [] : [policy.maxIdleSuspendMinutes])])].sort((a, b) => a - b);
  const change = (next: LimitsDraft) => {
    setDraft(next);
    setDirty(true);
  };

  const saveLimits = () =>
    void mutate("limits", (current) =>
      organizationCompute.updatePolicy(
        {
          expectedVersion: current.policy.version,
          maxWorkspaces: maxWorkspaces!,
          maxRunningWorkspaces: maxRunning,
          maxIdleSuspendMinutes: draft.maxIdleSuspendMinutes ? Number(draft.maxIdleSuspendMinutes) : null,
          allowedMachineClasses: allowLists(draft.machineClasses, current.policy.allowedMachineClasses),
          allowedLocations: allowLists(draft.locations, current.policy.allowedLocations),
        },
        current.contextRevision,
      ),
    );

  const togglePause = () =>
    void mutate("pause", (current) =>
      organizationCompute.setProvisioningPaused(
        current.policy.version,
        !current.policy.provisioningPaused,
        current.policy.provisioningPaused ? null : reason.trim() || null,
        current.contextRevision,
      ),
    ).then((saved) => {
      if (saved) setReason("");
    });

  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Cloud compute</div>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh cloud compute" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground" aria-label="Billing responsibility">
        Cloud workspaces run on the provider account this organization connected. That provider bills the account directly for compute and storage,
        separately from agent usage and from any TerminalX plan. These limits stop new workspaces from starting; they are not a spending cap. Provider
        billing can arrive late, and stopped disks, archives and snapshots keep charging until they are deleted.
      </p>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Compute status">
        <span>
          Workspaces {counts.workspaces} of {Math.min(policy.maxWorkspaces, ceiling)}
        </span>
        <span>
          Running {counts.running}
          {policy.maxRunningWorkspaces === null ? " (no running limit)" : ` of ${policy.maxRunningWorkspaces}`}
        </span>
      </div>
      {policy.provisioningPaused && (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]" role="status">
          New workspaces are paused{policy.pausedReason ? `: ${policy.pausedReason}` : ""}. Existing workspaces keep running and billing.
        </p>
      )}

      {alerts.length > 0 && (
        <ul aria-label="Compute alerts" className="mt-2 flex flex-col gap-1">
          {alerts.map((alert, index) => (
            <li
              key={`${alert.code}:${alert.provider ?? ""}:${alert.workspaceId ?? ""}:${index}`}
              className={`text-[11px] ${alert.severity === "info" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}
            >
              {alertMessage(alert)}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <>
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">New workspaces</div>
            <div className="flex gap-2">
              {!policy.provisioningPaused && (
                <input
                  aria-label="Pause reason"
                  placeholder="Reason (optional)"
                  className={`${inputClass} min-w-0 flex-1`}
                  value={reason}
                  maxLength={200}
                  disabled={Boolean(busy)}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
              <Button size="sm" className="h-7" variant={policy.provisioningPaused ? "default" : "outline"} disabled={Boolean(busy)} onClick={togglePause}>
                {busy === "pause" ? <Loader2 className="animate-spin" /> : policy.provisioningPaused ? "Allow new workspaces" : "Pause new workspaces"}
              </Button>
            </div>
          </div>

          <form
            className="mt-3 flex flex-col gap-2"
            aria-label="Compute limits"
            onSubmit={(event) => {
              event.preventDefault();
              if (!limitsInvalid) saveLimits();
            }}
          >
            <div className="text-xs font-medium text-muted-foreground">Limits</div>
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                Workspaces
                <input
                  aria-label="Maximum workspaces"
                  inputMode="numeric"
                  className={inputClass}
                  value={draft.maxWorkspaces}
                  disabled={Boolean(busy)}
                  onChange={(event) => change({ ...draft, maxWorkspaces: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                Running at once
                <input
                  aria-label="Maximum running workspaces"
                  inputMode="numeric"
                  placeholder="No limit"
                  className={inputClass}
                  value={draft.maxRunningWorkspaces}
                  disabled={Boolean(busy)}
                  onChange={(event) => change({ ...draft, maxRunningWorkspaces: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                Idle suspend at most
                <select
                  aria-label="Maximum idle suspend"
                  className={inputClass}
                  value={draft.maxIdleSuspendMinutes}
                  disabled={Boolean(busy)}
                  onChange={(event) => change({ ...draft, maxIdleSuspendMinutes: event.target.value })}
                >
                  <option value="">No limit</option>
                  {idleOptions.map((minutes) => (
                    <option key={minutes} value={String(minutes)}>
                      {minutes} min
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {maxWorkspaces === null && <p className="text-[11px] text-destructive">Workspaces must be a whole number from 1 to {ceiling}, the most this TerminalX service allows.</p>}
            {runningInvalid && <p className="text-[11px] text-destructive">Running at once must be blank or a whole number no larger than the workspace limit.</p>}
            <div className="text-[11px] text-muted-foreground">Allowed sizes and regions (comma-separated IDs; blank allows any)</div>
            {COMPUTE_PROVIDERS.map((provider) => (
              <div key={provider} className="grid grid-cols-[5rem_1fr_1fr] items-center gap-2">
                <span className="text-[11px]">{providerLabel(provider)}</span>
                <input
                  aria-label={`Allowed sizes for ${providerLabel(provider)}`}
                  placeholder="Any size"
                  className={inputClass}
                  value={draft.machineClasses[provider]}
                  disabled={Boolean(busy)}
                  onChange={(event) => change({ ...draft, machineClasses: { ...draft.machineClasses, [provider]: event.target.value } })}
                />
                <input
                  aria-label={`Allowed regions for ${providerLabel(provider)}`}
                  placeholder="Any region"
                  className={inputClass}
                  value={draft.locations[provider]}
                  disabled={Boolean(busy)}
                  onChange={(event) => change({ ...draft, locations: { ...draft.locations, [provider]: event.target.value } })}
                />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" className="h-7" type="submit" disabled={Boolean(busy) || limitsInvalid}>
                {busy === "limits" ? <Loader2 className="animate-spin" /> : "Save limits"}
              </Button>
              <p className="text-[11px] text-faint">Lowering a limit never stops running workspaces; it refuses new ones until usage drops.</p>
            </div>
          </form>
        </>
      ) : (
        <div className="mt-3 text-[11px] leading-relaxed text-muted-foreground" aria-label="Compute limits">
          <p>Only owners and admins can change compute limits.</p>
          {policy.maxIdleSuspendMinutes !== null && <p>Workspaces must suspend after at most {policy.maxIdleSuspendMinutes} idle minutes.</p>}
          {[...new Set([...Object.keys(policy.allowedMachineClasses), ...Object.keys(policy.allowedLocations)])].sort().map((provider) => (
            <p key={provider}>
              {providerLabel(provider)}: sizes {policy.allowedMachineClasses[provider]?.join(", ") ?? "any"}; regions{" "}
              {policy.allowedLocations[provider]?.join(", ") ?? "any"}
            </p>
          ))}
        </div>
      )}

      {canEdit && usageError && <p className="mt-2 text-xs text-destructive">{usageError}</p>}
      {usage && <UsageReport usage={usage} />}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function UsageReport({ usage }: { usage: ComputeUsageReport }) {
  return (
    <div className="mt-3 flex flex-col gap-2" aria-label="Provider usage">
      <div className="text-xs font-medium text-muted-foreground">Usage since {new Date(usage.period.start).toLocaleDateString()}</div>
      {usage.providers.length === 0 && <p className="text-[11px] text-muted-foreground">No cloud workspaces yet.</p>}
      {usage.providers.map((provider) => (
        <ProviderUsage key={provider.provider} usage={provider} />
      ))}
      {usage.retained.length > 0 && (
        <>
          <div className="text-[11px] font-medium text-muted-foreground">Storage that may keep charging</div>
          <ul aria-label="Retained storage" className="flex flex-col divide-y divide-hairline">
            {usage.retained.map((item) => (
              <li key={item.workspaceId} className="flex items-center gap-2 py-1.5 text-[11px]" aria-label={item.name}>
                <span className="min-w-0 flex-1 truncate">
                  {item.name} · {providerLabel(item.provider)}
                </span>
                <span className="text-muted-foreground">
                  {item.kind === "stopped-disk" ? "Stopped disk" : item.kind === "archived-disk" ? "Archived" : "Deletion pending"}
                  {item.diskGiB ? ` · ${item.diskGiB} GiB` : ""}
                  {item.estimatedMonthlyMicros !== null ? ` · ~${formatMicros(item.estimatedMonthlyMicros, item.currency)}/mo` : " · price unknown"}
                  {item.deleteAfter ? ` · deleted after ${new Date(item.deleteAfter).toLocaleDateString()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProviderUsage({ usage }: { usage: ComputeProviderUsage }) {
  const reported = usage.providerReported;
  return (
    <div className="rounded-md bg-well p-2 text-[11px]" aria-label={`${providerLabel(usage.provider)} usage`}>
      <div className="font-medium">{providerLabel(usage.provider)}</div>
      <dl className="mt-1 grid grid-cols-[7.5rem_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">Measured runtime</dt>
        <dd>
          {formatHours(usage.measured.runtimeSeconds)} <span className="text-faint">from TerminalX records, as of {formatTime(usage.measured.observedAt)}</span>
        </dd>
        <dt className="text-muted-foreground">Estimate</dt>
        <dd>
          {formatMicros(usage.estimate.computeMicros, usage.currency)} compute
          {usage.estimate.retainedStorageMonthlyMicros > 0 &&
            ` + ${formatMicros(usage.estimate.retainedStorageMonthlyMicros, usage.currency)}/mo retained storage`}
          {usage.estimate.retainedStorageUnpricedCount > 0 && ` (${usage.estimate.retainedStorageUnpricedCount} unpriced)`}{" "}
          <span className="text-faint">at quoted rates from {formatTime(usage.estimate.pricingObservedAt)}</span>
        </dd>
        <dt className="text-muted-foreground">Provider billing</dt>
        <dd>
          {reported.status === "unavailable" || reported.totalMicros === undefined ? (
            <span className="text-faint">Not reported to TerminalX. Check the provider's console for the invoice.</span>
          ) : (
            <>
              {formatMicros(reported.totalMicros, reported.currency ?? usage.currency)}{" "}
              <span className={reported.status === "delayed" ? "text-amber-600 dark:text-amber-400" : "text-faint"}>
                reported {formatTime(reported.providerReportedAt)}
                {reported.status === "delayed" ? " (delayed)" : ""}
              </span>
            </>
          )}
        </dd>
      </dl>
    </div>
  );
}
