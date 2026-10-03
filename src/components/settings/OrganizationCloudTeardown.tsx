import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type CloudTeardown, type CloudTeardownResource } from "@/lib/api";
import { cloudOrgArg } from "@/lib/cloudCatalog";
import { dateText, deadlineText } from "@/lib/cloudLifecycle";
import { cloudProviderName } from "@/lib/cloudSession";

type Disposition = "archive" | "destroy";

const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? String(error.code) : "");

export function teardownErrorMessage(code: string): string {
  switch (code) {
    case "organization_admin_required":
    case "forbidden":
      return "Only an organization owner or administrator can shut down its cloud workspaces.";
    case "account_context_changed":
      return "The account or organization changed. Refresh before trying again.";
    case "cloud_workspace_request_outcome_unknown":
      return "The request may or may not have gone through. Refresh to see whether the shutdown started before trying again.";
    case "cloud_workspace_unavailable":
      return "This server does not offer an organization-wide shutdown.";
    default:
      return `The shutdown could not be read or started (${code || "unknown"}). Nothing was changed unless a refresh shows otherwise.`;
  }
}

const KINDS: Record<string, string> = { workspace: "Workspace", "session-runtime": "Session runtime", "build-template": "Build template" };

/** One line for a resource that is still at a provider. */
export function teardownResourceText(resource: CloudTeardownResource, now = Date.now()): string {
  const kind = KINDS[resource.kind] ?? resource.kind;
  const when = resource.deleteAfter ? `, deleted ${deadlineText(resource.deleteAfter, now)}` : "";
  const cleanup = resource.cleanupRequired ? ", cleanup unresolved" : "";
  return `${cloudProviderName(resource.provider)} · ${kind} ${resource.id}: ${resource.state}${when}${cleanup}`;
}

/**
 * Shut down an organization's cloud workspaces, all of them (PRO-34, saas
 * contract §10.7): archive every workspace with one shared deadline, or
 * delete them now. For owners and administrators; the server decides.
 *
 * It cannot be cancelled, and while it runs nobody in the organization can
 * create, resume or unarchive a workspace. So nothing is sent before the
 * person has chosen what happens to the data and typed the organization's
 * name. An archive may later be escalated to deleting now, never the reverse.
 * What still remains at the providers is listed until nothing does; things
 * the shutdown does not remove (session runtimes, build templates) are named
 * so they are not mistaken for progress.
 */
export function OrganizationCloudTeardown({
  contextRevision,
  organizationName,
  member = false,
  orgId = null,
}: {
  contextRevision: string;
  organizationName: string;
  member?: boolean;
  /** The organization to shut down: the active one when none (Settings). */
  orgId?: string | null;
}) {
  const [teardown, setTeardown] = useState<CloudTeardown | null>(null);
  const [loading, setLoading] = useState(!member);
  const [loaded, setLoaded] = useState(false);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [disposition, setDisposition] = useState<Disposition | "">("");
  const [typed, setTyped] = useState("");
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const current = ++loadSeq.current;
    setLoading(true);
    try {
      const status = await api.cloudTeardownStatus(cloudOrgArg(orgId));
      if (current !== loadSeq.current) return;
      setTeardown(status);
      setLoaded(true);
      setError(null);
    } catch (e) {
      if (current !== loadSeq.current) return;
      const code = errorCode(e);
      // Not theirs to see: the section is for owners and administrators.
      if (code === "organization_admin_required" || code === "forbidden") setRefused(true);
      else setError(teardownErrorMessage(code));
    } finally {
      if (current === loadSeq.current) setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    setTeardown(null);
    setLoaded(false);
    setRefused(false);
    setConfirming(false);
    setDisposition("");
    setTyped("");
    // The account already says this is a member: skip a request the server refuses.
    if (!member) void load();
    return () => {
      loadSeq.current += 1;
    };
  }, [contextRevision, member, load]);

  if (member || refused) return null;

  const pending = !!teardown && !teardown.completedAt;
  const escalating = pending && teardown.disposition === "archive";
  // A pending archive can only be turned into a delete; a pending delete has nothing left to choose.
  const choices: Disposition[] = escalating ? ["destroy"] : ["archive", "destroy"];
  const chosen: Disposition | "" = escalating ? "destroy" : disposition;
  const nameMatches = typed.trim() === organizationName.trim() && organizationName.trim() !== "";
  // Only once the status is known: none yet, one that finished (a new one may start), or an archive that may be escalated.
  const canStart = loaded && !loading && (!teardown || !!teardown.completedAt || escalating);

  const start = async () => {
    if (!chosen || !nameMatches) return;
    setBusy(true);
    setError(null);
    try {
      setTeardown(await api.cloudTeardownRequest(chosen, cloudOrgArg(orgId)));
      setConfirming(false);
      setDisposition("");
      setTyped("");
    } catch (e) {
      setError(teardownErrorMessage(errorCode(e)));
    } finally {
      setBusy(false);
    }
  };

  const remaining = teardown?.remaining ?? [];
  const kept = (teardown?.resources ?? []).filter((resource) => !remaining.some((left) => left.id === resource.id && left.provider === resource.provider));
  const notWorkspaces = remaining.filter((resource) => resource.kind !== "workspace");

  return (
    <section className="rounded-lg border border-hairline px-3 py-3 text-xs" aria-label="Shut down cloud workspaces" data-testid="cloud-teardown">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium">Shut down cloud workspaces</div>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Refresh shutdown status" disabled={loading || busy} onClick={() => void load()}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {!teardown && loaded && !loading && (
        <p className="mt-1 leading-relaxed text-muted-foreground">
          Archives or deletes every cloud workspace of {organizationName}, for everyone in it. Use it before closing the organization or leaving a provider for good.
        </p>
      )}

      {pending && (
        <div className="mt-2 flex flex-col gap-1" role="status" data-testid="cloud-teardown-status" data-disposition={teardown.disposition}>
          <span className="font-medium">
            {teardown.disposition === "archive"
              ? `Shutdown in progress: every workspace is archived, and deleted on ${dateText(teardown.retentionDeadline)} (${deadlineText(teardown.retentionDeadline)}).`
              : "Shutdown in progress: every workspace is being deleted."}
          </span>
          <span className="text-muted-foreground">
            Started {dateText(teardown.requestedAt)}. Nobody in the organization can create, resume or unarchive a cloud workspace until it finishes. It cannot be cancelled.
            {teardown.disposition === "archive" ? " Storage keeps billing at the provider until the workspaces are deleted." : ""}
          </span>
        </div>
      )}

      {teardown?.completedAt && (
        <div className="mt-2 flex flex-col gap-1" role="status" data-testid="cloud-teardown-status" data-disposition="completed">
          <span className="font-medium">Shut down on {dateText(teardown.completedAt)}: nothing that blocks closing the organization remains.</span>
          <span className="text-muted-foreground">New cloud workspaces can be created again. Running the shutdown again starts a new one.</span>
        </div>
      )}

      {teardown && remaining.length > 0 && (
        <div className="mt-2">
          <div className="text-muted-foreground">
            {remaining.length} {remaining.length === 1 ? "thing remains" : "things remain"} at the providers:
          </div>
          <ul className="mt-1 flex flex-col gap-0.5" aria-label="Remaining resources">
            {remaining.map((resource) => (
              <li key={`${resource.provider}:${resource.kind}:${resource.id}`} className="break-words font-mono text-[11px]" data-testid="cloud-teardown-remaining">
                {teardownResourceText(resource)}
              </li>
            ))}
          </ul>
          {notWorkspaces.length > 0 && (
            <p className="mt-1 flex items-start gap-1.5 text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>The shutdown removes workspaces only. Session runtimes and build templates are removed from their own screens, and it does not finish until they are.</span>
            </p>
          )}
        </div>
      )}
      {teardown && kept.length > 0 && (
        <p className="mt-2 text-muted-foreground" data-testid="cloud-teardown-kept">
          {kept.length} released {kept.length === 1 ? "workspace is" : "workspaces are"} still listed because the provider kept {kept.length === 1 ? "it" : "them"} or stopped reporting {kept.length === 1 ? "it" : "them"}; check the provider's
          console.
        </p>
      )}

      {error && (
        <p className="mt-2 text-destructive" role="alert">
          {error}
        </p>
      )}

      {canStart ? (
        !confirming ? (
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            disabled={loading || busy}
            onClick={() => {
              setConfirming(true);
              setError(null);
            }}
          >
            {escalating ? "Delete everything now…" : "Shut down cloud workspaces…"}
          </Button>
        ) : (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-destructive/25 p-3" data-testid="cloud-teardown-confirm">
            <p>
              {escalating
                ? "This deletes every archived workspace now instead of at the deadline. It cannot be undone or cancelled."
                : "This applies to every cloud workspace of the organization, whoever created it, and cannot be cancelled once started. Choose what happens to them:"}
            </p>
            {choices.includes("archive") && (
              <label className="flex items-start gap-2">
                <input type="radio" name="teardown-disposition" checked={chosen === "archive"} onChange={() => setDisposition("archive")} disabled={busy} />
                <span>Archive everything: stop every workspace and keep it for 30 days, then delete it. Storage keeps billing at the provider until then. You can still delete everything sooner.</span>
              </label>
            )}
            {!escalating && (
              <label className="flex items-start gap-2">
                <input type="radio" name="teardown-disposition" checked={chosen === "destroy"} onChange={() => setDisposition("destroy")} disabled={busy} />
                <span>Delete everything now: machines, disks, snapshots and saved conversations. Uncommitted and unpushed work is lost. This cannot be undone.</span>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span>
                Type the organization's name, <span className="font-medium">{organizationName}</span>, to confirm:
              </span>
              <input
                className="h-8 rounded-md border border-hairline bg-background px-2 text-xs"
                aria-label="Organization name"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="destructive" disabled={busy || !chosen || !nameMatches} onClick={() => void start()}>
                {busy && <Loader2 className="animate-spin" />}
                {chosen === "archive" ? "Archive every workspace" : "Delete every workspace"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setTyped("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
