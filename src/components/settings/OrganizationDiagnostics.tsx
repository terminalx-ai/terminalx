import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cloudOrgArg } from "@/lib/cloudCatalog";
import { cn } from "@/lib/cn";
import {
  DEFAULT_DIAGNOSTICS_WINDOW_DAYS,
  DIAGNOSTICS_WINDOW_OPTIONS,
  diagnosticsErrorMessage,
  exportErrorMessage,
  formatDuration,
  retryHint,
  type CloudDiagnostics,
  type ConnectionClose,
  type DiagnosticsOperationTimings,
} from "@/lib/cloudDiagnostics";

const formatTime = (timestamp: number | null | undefined) => (timestamp ? new Date(timestamp).toLocaleString() : "—");
const errorCode = (error: unknown) => (error && typeof error === "object" && "code" in error ? String(error.code) : "");

function Timings({ label, timings }: { label: string; timings: DiagnosticsOperationTimings | null }) {
  const stages = Object.entries(timings?.stages ?? {});
  return (
    <div aria-label={`${label} timings`} className="rounded-md bg-well p-2">
      <div className="text-xs font-medium">
        {label} · {timings?.samples ?? 0} {timings?.samples === 1 ? "sample" : "samples"}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Total p50 {formatDuration(timings?.totalMs.p50)} · p95 {formatDuration(timings?.totalMs.p95)}
      </div>
      {stages.length > 0 && (
        <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[11px]">
          {stages.map(([stage, timing]) => (
            <div key={stage} className="contents">
              <dt className="truncate text-faint">{stage}</dt>
              <dd className="text-right tabular-nums">
                {formatDuration(timing.p50)} / {formatDuration(timing.p95)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Cloud diagnostics for organization owners and administrators (PRO-38).
 * The server decides who may see them, by the role in the organization asked
 * for; a member gets a short explanation.
 */
export function OrganizationDiagnostics({
  contextRevision,
  member = false,
  orgId = null,
  workspaceId = null,
  framed = true,
}: {
  contextRevision: string;
  member?: boolean;
  /** The organization to report on: the active one when none (Settings). */
  orgId?: string | null;
  /** The workspace the view was opened from; its rows are marked. */
  workspaceId?: string | null;
  /** False inside a dialog, which has its own frame and title. */
  framed?: boolean;
}) {
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_DIAGNOSTICS_WINDOW_DAYS);
  const [diagnostics, setDiagnostics] = useState<CloudDiagnostics | null>(null);
  const [closes, setCloses] = useState<ConnectionClose[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: boolean; text: string } | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async (days: number) => {
    const current = ++loadSeq.current;
    setLoading(true);
    // The account already says this is a member: skip a request the server refuses.
    const refused = Promise.reject({ code: "organization_admin_required" });
    refused.catch(() => {});
    const [server, local] = await Promise.allSettled([member ? refused : api.cloudDiagnostics(days, cloudOrgArg(orgId)), api.cloudConnectionDiagnostics()]);
    if (current !== loadSeq.current) return;
    if (server.status === "fulfilled") {
      setDiagnostics(server.value);
      setError(null);
    } else {
      setDiagnostics(null);
      setError(server.reason);
    }
    setCloses(local.status === "fulfilled" ? local.value : []);
    setLoading(false);
  }, [member, orgId]);

  useEffect(() => {
    setDiagnostics(null);
    setError(null);
    setExportResult(null);
    void load(windowDays);
    return () => {
      loadSeq.current += 1;
    };
  }, [contextRevision, windowDays, load]);

  const exportDiagnostics = async () => {
    setExportResult(null);
    const path = await save({
      title: "Export cloud diagnostics",
      defaultPath: `terminalx-cloud-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    }).catch(() => null);
    if (!path) return;
    setExporting(true);
    try {
      await api.cloudDiagnosticsExport(path, windowDays, cloudOrgArg(orgId));
      setExportResult({ ok: true, text: `Saved to ${path}` });
    } catch (failure) {
      setExportResult({ ok: false, text: exportErrorMessage(failure) });
    } finally {
      setExporting(false);
    }
  };

  // A member sees why the organization's part is missing, and still gets
  // this Mac's own connection closes and their export.
  const memberOnly = errorCode(error) === "organization_admin_required";
  const operations = diagnostics?.operations ?? [];
  const workspaces = diagnostics?.workspaces ?? [];
  return (
    <div className={cn(framed && "rounded-lg border border-hairline p-3")} data-testid="cloud-diagnostics">
      <div className="flex items-center justify-between gap-2">
        {/* A dialog names the view in its own title. */}
        <div className="min-w-0 truncate text-sm font-medium">{framed ? "Cloud diagnostics" : "Recent activity"}</div>
        <div className="flex shrink-0 items-center gap-1">
          {!memberOnly && (
            <select
              aria-label="Diagnostics window"
              className="h-7 rounded-md border border-hairline bg-background px-2 text-xs"
              value={windowDays}
              disabled={loading}
              onChange={(event) => setWindowDays(Number(event.target.value))}
            >
              {DIAGNOSTICS_WINDOW_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  Last {days} {days === 1 ? "day" : "days"}
                </option>
              ))}
            </select>
          )}
          <Button variant="ghost" size="icon-xs" aria-label="Refresh cloud diagnostics" disabled={loading} onClick={() => void load(windowDays)}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        Recent cloud operations, stage timings and connection health for this organization. The server sends identifiers, states and error codes only — no
        workspace or repository names, credentials, tokens or logs.
      </p>

      {memberOnly ? (
        <p role="status" className="mt-2 text-[11px] text-muted-foreground">
          {diagnosticsErrorMessage(error)}
        </p>
      ) : (
        error != null && (
          <p role="alert" className="mt-2 text-[11px] text-destructive">
            {diagnosticsErrorMessage(error)}
          </p>
        )
      )}
      {loading && !diagnostics && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading diagnostics…
        </p>
      )}

      {diagnostics && (
        <>
          <p className="mt-2 text-[11px] text-faint">
            {formatTime(diagnostics.window.from)} – {formatTime(diagnostics.window.to)}
            {diagnostics.window.truncated ? ` · showing the latest ${diagnostics.window.maxOperations ?? operations.length} operations` : ""}
            {diagnostics.retention?.operationHistoryDays ? ` · history kept ${diagnostics.retention.operationHistoryDays} days` : ""}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Timings label="Create" timings={diagnostics.stageTimings.create} />
            <Timings label="Resume" timings={diagnostics.stageTimings.resume} />
          </div>

          <div className="mt-3 text-xs font-medium text-muted-foreground">Recent operations</div>
          {operations.length ? (
            <ul aria-label="Recent operations" className="mt-1 flex flex-col divide-y divide-hairline text-[11px]">
              {operations.map((operation) => (
                <li key={operation.operationId} className={cn("py-1.5", workspaceId && operation.workspaceId === workspaceId && "-mx-1 rounded-sm bg-selected/50 px-1")} data-current={workspaceId && operation.workspaceId === workspaceId ? "" : undefined}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{operation.type}</span>
                    <span>{operation.state}</span>
                    {operation.stage && <span className="text-muted-foreground">at {operation.stage}</span>}
                    {operation.errorCode && <code className="font-mono text-destructive">{operation.errorCode}</code>}
                    <span className="ml-auto text-faint">{formatTime(operation.updatedAt)}</span>
                  </div>
                  <div className="truncate font-mono text-faint">
                    {operation.workspaceId} · {operation.provider ?? "—"} · {formatDuration(operation.durationMs)}
                    {operation.attemptCount && operation.attemptCount > 1 ? ` · ${operation.attemptCount} attempts` : ""}
                  </div>
                  {operation.retryAction && operation.retryAction !== "none" && <div className="text-muted-foreground">{retryHint(operation.retryAction)}</div>}
                  {operation.restartDecision && (
                    <div className="text-muted-foreground">
                      Restart: {operation.restartDecision.path}
                      {operation.restartDecision.reason ? ` (${operation.restartDecision.reason})` : ""}
                      {operation.restartDecision.decidedAt ? ` · decided ${formatTime(operation.restartDecision.decidedAt)}` : ""}
                      {operation.restartDecision.fence ? ` · fence ${operation.restartDecision.fence}` : ""}
                      {operation.restartDecision.replacedRuntimeGeneration != null
                        ? ` · replaced generation ${operation.restartDecision.replacedRuntimeGeneration}`
                        : ""}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">No cloud operations in this window.</p>
          )}

          <div className="mt-3 text-xs font-medium text-muted-foreground">Workspace connections</div>
          {workspaces.length ? (
            <ul aria-label="Workspace connections" className="mt-1 flex flex-col gap-0.5 text-[11px]">
              {workspaces.map((workspace) => (
                <li key={workspace.workspaceId} className={cn("flex flex-wrap gap-x-2", workspaceId && workspace.workspaceId === workspaceId && "-mx-1 rounded-sm bg-selected/50 px-1")} data-current={workspaceId && workspace.workspaceId === workspaceId ? "" : undefined}>
                  <span className="truncate font-mono">{workspace.workspaceId}</span>
                  <span className="text-muted-foreground">{workspace.state}</span>
                  {workspace.oomRelaunchCount ? <span className="text-destructive">{workspace.oomRelaunchCount} out-of-memory relaunches</span> : null}
                  <span className="ml-auto tabular-nums">
                    {workspace.connections.ready} ready · {workspace.connections.waitingForRuntime} waiting · {workspace.connections.expired} expired
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">No cloud workspaces.</p>
          )}

          {diagnostics.closeReasons.length > 0 && (
            <>
              <div className="mt-3 text-xs font-medium text-muted-foreground">Relay close reasons</div>
              <dl aria-label="Relay close reasons" className="mt-1 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px]">
                {diagnostics.closeReasons.map((reason) => (
                  <div key={reason.code} className="contents">
                    <dt className="font-mono tabular-nums">{reason.code}</dt>
                    <dd>
                      <span className="font-mono">{reason.name}</span>
                      {reason.retryAction ? <span className="text-muted-foreground"> — {retryHint(reason.retryAction)}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </>
      )}

      <div className="mt-3 text-xs font-medium text-muted-foreground">Connection closes on this Mac</div>
      {closes.length ? (
        <ul aria-label="Connection closes on this Mac" className="mt-1 flex flex-col gap-0.5 text-[11px]">
          {[...closes].reverse().map((close, index) => (
            <li key={`${close.at}:${index}`} className="flex flex-wrap gap-x-2">
              <span className="font-mono tabular-nums">{close.code}</span>
              <span className="font-mono">{close.name}</span>
              <span className="truncate font-mono text-faint">{close.workspaceId ?? "dev attach"}</span>
              <span className="ml-auto text-faint">{formatTime(close.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">No relay closes recorded since TerminalX started. The last 50 are kept in memory only.</p>
      )}

      <div className="mt-3 flex flex-col gap-1.5 rounded-md border border-hairline p-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The export is written only to a file you choose and is never uploaded. It holds the app version, OS and architecture, the diagnostics above and
          this Mac's connection closes. It leaves out API keys and provider credentials, access and refresh tokens, sign-in, device and pairing codes, relay
          tickets, runtime credentials, workspace and repository names, file contents, terminal output and prompts.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7" disabled={exporting} onClick={() => void exportDiagnostics()}>
            {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export diagnostics…
          </Button>
          {exportResult && (
            <span role={exportResult.ok ? "status" : "alert"} className={`truncate text-[11px] ${exportResult.ok ? "text-muted-foreground" : "text-destructive"}`}>
              {exportResult.text}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
