import { useMemo } from "react";
import { Cloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { placeCloudProjects, useCloudCatalog } from "@/lib/cloudCatalog";
import { CreateRefused, createErrorMessage, isClientError } from "@/lib/cloudCreate";
import type { PreparedCreate } from "@/lib/cloudNewSession";
import { formatMicros } from "@/lib/organizationCompute";
import { usePrefs } from "@/lib/prefs";
import { useSessionStore } from "@/lib/sessions";
import type { CloudProject } from "@/types/target";

/**
 * The cloud half of the new-session form (PRO-23): which cloud project the
 * form is for, and the one-time cost confirmation a new workspace needs.
 */

/** The cloud project the new-session form is preset with, and its organization's name; null for a local draft. */
export function useCloudDraft(): { project: CloudProject | null; orgName: string } | null {
  const store = useSessionStore();
  const catalog = useCloudCatalog();
  const prefs = usePrefs();
  const { status } = useAccount();
  const key = store.cloudSessionPreset?.projectKey ?? null;
  return useMemo(() => {
    if (!key) return null;
    const orgId = key.slice("cloud:".length).split(":")[0];
    const org = status.organizations?.find((item) => item.id === orgId);
    const orgName = org ? (org.isPersonal ? "Personal" : org.name) : "Organization";
    const placed = placeCloudProjects(catalog.orgs[orgId] ?? { orgId, workspaces: [], repositories: null }, catalog.createMemory, {
      pinned: prefs.cloudPinned[orgId],
      added: prefs.cloudProjects[orgId],
      blank: prefs.cloudBlankProjects[orgId],
    });
    const project = [...placed.projects, ...placed.more].find((item) => item.key === key) ?? null;
    return { project, orgName };
  }, [key, catalog, prefs.cloudPinned, prefs.cloudProjects, prefs.cloudBlankProjects, status.organizations]);
}

export function cloudStartError(error: unknown): string {
  if (error instanceof CreateRefused) return createErrorMessage(error.code, error.detail);
  if (isClientError(error)) return createErrorMessage(error.code);
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : error instanceof Error ? error.message : null;
  if (code === "cloud_workspace_unreachable") return "The cloud workspace did not come up in time. Try again.";
  if (code === "cloud_runtime_update_required") return "The cloud workspace's runtime needs an update before it can start sessions.";
  if (code === "cloud_workspace_stopped") return "The cloud workspace is stopped.";
  if (code && /^[a-z_]+$/.test(code)) return createErrorMessage(code);
  return errorMessage(error);
}

/**
 * The spend confirmation for a new workspace, shown once per create: the
 * quota first, then the provider, the machine and its price. Nothing is
 * created until Create is pressed.
 */
export function CloudCreateConfirm({ prepared, orgName, busy, onConfirm, onCancel }: { prepared: PreparedCreate; orgName: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { quote, quota } = prepared;
  const config = quote.configuration;
  const hourly = formatMicros(quote.activeHourlyMicros, quote.currency);
  const suspended = quote.estimatedSuspendedMonthlyMicros !== null ? formatMicros(quote.estimatedSuspendedMonthlyMicros, quote.currency) : null;
  return (
    <div className="mb-3 rounded-xl border border-hairline bg-well p-3 text-xs" role="group" aria-label="Confirm a new cloud workspace" data-testid="cloud-create-confirm">
      <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
        <Cloud className="size-4" /> {prepared.project.blank ? `Create the ${prepared.project.fullName} workspace` : `Create a cloud workspace for ${prepared.project.fullName}`}
      </div>
      <p className="text-muted-foreground" data-testid="cloud-create-quota">
        {quota ? `${orgName} has ${quota.used} of ${quota.limit} cloud workspaces in use; this adds one.` : `${orgName}'s workspace limit applies; this adds one workspace.`}
      </p>
      <p className="mt-1 text-muted-foreground">
        {prepared.providerLabel} · {config.machineClassLabel} ({config.vcpu} vCPU, {Math.round(config.memoryMiB / 1024)} GB) · {config.locationLabel}
      </p>
      <p className="mt-1 text-foreground" data-testid="cloud-create-price">
        {hourly} an hour while it runs{quote.pricing === "estimate" ? " (estimate)" : ""}
        {suspended ? `, about ${suspended} a month while stopped` : ""}. It stops itself after {config.idleSuspendMinutes} idle minutes.
      </p>
      {prepared.project.blank && <p className="mt-1 text-muted-foreground">It starts as an empty folder with Git, so changes can be tracked.</p>}
      <div className="mt-2 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="accent" onClick={onConfirm} disabled={busy} data-testid="cloud-create-confirm-button">
          {busy ? <Loader2 className="animate-spin" /> : null}
          Create workspace and start
        </Button>
      </div>
    </div>
  );
}
