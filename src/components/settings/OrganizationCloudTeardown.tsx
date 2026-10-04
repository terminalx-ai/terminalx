import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type CloudTeardown, type CloudTeardownPreview, type CloudTeardownResource } from "@/lib/api";
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
      return "The account or the active organization changed after this was opened, so nothing was sent. Check which organization is selected, then start again.";
    case "cloud_workspace_request_outcome_unknown":
      return "The request may or may not have gone through. Refresh to see whether the shutdown started before trying again.";
    case "cloud_workspace_unavailable":
      return "This server does not offer an organization-wide shutdown.";
    case "cloud_teardown_preview_changed":
      return "The organization's workspaces changed after the count was shown, so nothing was sent. Open the confirmation again to see the current count.";
    case "cloud_teardown_in_progress":
      return "A shutdown is already running for this organization.";
    default:
      return "The shutdown could not be read or started. Nothing was changed unless a refresh shows otherwise.";
  }
}

/** The server's resource kinds (saas `CloudProviderResource.kind`), in the app's words. */
const KINDS: Record<string, string> = { workspace: "Workspace", runtime: "Session runtime", build: "Runtime build or template", "legacy-operation": "Earlier operation" };
/** The server's state words per kind, in the app's own. An unknown one is shown as it comes. */
const MACHINE_STATES: Record<string, string> = {
  ready: "running",
  suspended: "stopped",
  archived: "archived",
  provisioning: "changing state",
  "attention-required": "needs attention",
  deleting: "being deleted",
  destroyed: "released",
};
const BUILD_STATES: Record<string, string> = {
  queued: "waiting to build",
  running: "building",
  succeeded: "built",
  failed: "failed",
  active: "in use",
  "organization-active": "in use",
  retired: "retired",
  archived: "archived",
};
const OPERATION_STATES: Record<string, string> = { queued: "waiting", running: "in progress", "cancel-requested": "being cancelled", succeeded: "finished", failed: "failed", canceled: "cancelled" };
const STATES: Record<string, Record<string, string>> = { workspace: MACHINE_STATES, runtime: MACHINE_STATES, build: BUILD_STATES, "legacy-operation": OPERATION_STATES };

/** What a teardown would take, in one sentence, private workspaces named as such. */
export function teardownPreviewText(preview: CloudTeardownPreview, organizationName: string): string {
  const { workspaces, othersPrivateWorkspaces: privateWorkspaces, archivedWorkspaces } = preview;
  if (workspaces === 0) return `${organizationName} has no cloud workspaces now. A shutdown still blocks new ones until it finishes.`;
  const count = `${workspaces} cloud workspace${workspaces === 1 ? "" : "s"}`;
  const hidden =
    privateWorkspaces > 0
      ? `, including ${privateWorkspaces} private one${privateWorkspaces === 1 ? "" : "s"} that ${privateWorkspaces === 1 ? "belongs" : "belong"} to other people and may not appear in your own list`
      : "";
  const archived = archivedWorkspaces > 0 ? ` ${archivedWorkspaces} ${archivedWorkspaces === 1 ? "is" : "are"} already archived.` : "";
  return `This takes every cloud workspace of ${organizationName}: ${count}${hidden}.${archived}`;
}

/** One line for a resource that is still at a provider. */
export function teardownResourceText(resource: CloudTeardownResource, now = Date.now()): string {
  const kind = KINDS[resource.kind] ?? resource.kind;
  const when = resource.deleteAfter ? `, deleted ${deadlineText(resource.deleteAfter, now)}` : "";
  const cleanup = resource.cleanupRequired ? ", cleanup unresolved" : "";
  return `${cloudProviderName(resource.provider)} · ${kind} ${resource.id}: ${STATES[resource.kind]?.[resource.state] ?? resource.state}${when}${cleanup}`;
}

/**
 * Shut down an organization's cloud workspaces, all of them (PRO-34, saas
 * contract §10.7): archive every workspace with one shared deadline, or
 * delete them now. For owners and administrators; the server decides.
 *
 * It cannot be cancelled, and while it runs nobody in the organization can
 * create, resume or unarchive a workspace. So nothing is sent before the
 * person has seen how many workspaces it takes (counted by the server, with
 * the private ones their own list leaves out), chosen what happens to the
 * data and typed the organization's name. The confirmation is for one
 * organization at one account context: both go with the request, and the
 * native side sends nothing if either changed meanwhile. An archive may later
 * be escalated to deleting now, never the reverse.
 * What still remains at the providers is listed until nothing does; things
 * the shutdown does not remove (session runtimes, build templates) are named
 * so they are not mistaken for progress.
 */
export function OrganizationCloudTeardown({
  contextRevision,
  organizationId,
  organizationName,
  member = false,
}: {
  contextRevision: string;
  /** The active organization, which is the one this shuts down. Without its id nothing is offered. */
  organizationId: string | null;
  organizationName: string;
  member?: boolean;
}) {
  const [teardown, setTeardown] = useState<CloudTeardown | null>(null);
  const [loading, setLoading] = useState(!member);
  const [loaded, setLoaded] = useState(false);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The organization and account context the open confirmation is for; they go with the request.
  const [confirming, setConfirming] = useState<{ organizationId: string; contextRevision: string } | null>(null);
  const [preview, setPreview] = useState<CloudTeardownPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Archive is the one that can still be undone for 30 days: it is the one preselected.
  const [disposition, setDisposition] = useState<Disposition>("archive");
  const [typed, setTyped] = useState("");
  const loadSeq = useRef(0);
  const sending = useRef(false);

  /** Close the confirmation and forget what was typed and counted for it. */
  const voidConfirmation = useCallback(() => {
    setConfirming(null);
    setPreview(null);
    setPreviewError(null);
    setDisposition("archive");
    setTyped("");
  }, []);

  const load = useCallback(async () => {
    const current = ++loadSeq.current;
    setLoading(true);
    try {
      const status = await api.cloudTeardownStatus(null);
      if (current !== loadSeq.current) return;
      // Only this organization's: an answer about another is not shown as its own.
      setTeardown(status && status.organizationId === organizationId ? status : null);
      setLoaded(true);
      setError(null);
    } catch (e) {
      if (current !== loadSeq.current) return;
      const code = errorCode(e);
      // Not theirs to see: the section is for owners and administrators.
      if (code === "organization_admin_required" || code === "forbidden") setRefused(true);
      else setError(teardownErrorMessage(code));
    } finally {
      if (current === loadSeq.current) {
        setLoading(false);
        // What the confirmation was opened against may no longer hold (a
        // shutdown may have started, or changed): it is void. In particular
        // a name typed to archive never carries over to "delete now".
        voidConfirmation();
      }
    }
  }, [organizationId, voidConfirmation]);

  useEffect(() => {
    setTeardown(null);
    setLoaded(false);
    setRefused(false);
    // A confirmation opened for another organization or context is void.
    voidConfirmation();
    // The account already says this is a member: skip a request the server refuses.
    if (!member && organizationId) void load();
    return () => {
      loadSeq.current += 1;
    };
  }, [contextRevision, organizationId, member, load, voidConfirmation]);

  if (member || refused || !organizationId) return null;

  const pending = !!teardown && !teardown.completedAt;
  const escalating = pending && teardown.disposition === "archive";
  // A pending archive can only be turned into a delete; a pending delete has nothing left to choose.
  const choices: Disposition[] = escalating ? ["destroy"] : ["archive", "destroy"];
  const chosen: Disposition = escalating ? "destroy" : disposition;
  const nameMatches = typed.trim() === organizationName.trim() && organizationName.trim() !== "";
  // Only once the status is known: none yet, one that finished (a new one may start), or an archive that may be escalated.
  const canStart = loaded && !loading && (!teardown || !!teardown.completedAt || escalating);

  const open = () => {
    const fence = { organizationId, contextRevision };
    setConfirming(fence);
    setError(null);
    setPreview(null);
    setPreviewError(null);
    api
      .cloudTeardownPreview(fence.organizationId)
      .then((counts) => {
        // Still the same confirmation, and about the organization it names.
        if (counts.organizationId === fence.organizationId) setPreview(counts);
        else setPreviewError(teardownErrorMessage("account_context_changed"));
      })
      .catch((e: unknown) => {
        const code = errorCode(e);
        setPreviewError(
          code === "account_context_changed"
            ? teardownErrorMessage(code)
            : "The number of workspaces this would take could not be read, so it cannot be started from here.",
        );
      });
  };

  const start = async () => {
    // One request per confirmation: a second click while the first is out does nothing.
    if (busy || sending.current || !confirming || !preview || !nameMatches) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      // For the organization and context the confirmation was opened at, and for exactly the workspaces it counted.
      const started = await api.cloudTeardownRequest(confirming.organizationId, confirming.contextRevision, chosen, { expectedWorkspaces: preview.workspaces, previewToken: preview.token });
      voidConfirmation();
      setTeardown(started);
    } catch (e) {
      const code = errorCode(e);
      // Whatever came of it, this confirmation is spent: the next attempt
      // starts from a fresh count and a freshly typed name.
      voidConfirmation();
      setError(teardownErrorMessage(code));
      // The outcome is not known: read what the server holds now.
      if (code === "cloud_workspace_request_outcome_unknown") await load().then(() => setError(teardownErrorMessage(code)));
    } finally {
      sending.current = false;
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
              <span>The shutdown removes workspaces only. Session runtimes, runtime builds and build templates are removed from their own screens, and it does not finish until they are.</span>
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
            onClick={open}
          >
            {escalating ? "Delete everything now…" : "Shut down cloud workspaces…"}
          </Button>
        ) : (
          <div className="mt-3 flex flex-col gap-2 rounded-md border border-destructive/25 p-3" data-testid="cloud-teardown-confirm">
            <p>
              {escalating
                ? "This deletes every archived workspace now instead of at the deadline. It cannot be undone or cancelled."
                : "This cannot be cancelled once started. Choose what happens to the workspaces:"}
            </p>
            {preview ? (
              <p className="font-medium" data-testid="cloud-teardown-count">
                {teardownPreviewText(preview, organizationName)}
              </p>
            ) : previewError ? (
              <p className="text-destructive" role="alert">
                {previewError}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Counting the organization's workspaces…
              </p>
            )}
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
              <Button size="sm" variant="destructive" disabled={busy || !preview || !nameMatches} onClick={() => void start()}>
                {busy && <Loader2 className="animate-spin" />}
                {chosen === "archive" ? "Archive every workspace" : "Delete every workspace"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setConfirming(null);
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
