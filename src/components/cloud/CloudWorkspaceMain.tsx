import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Cloud, Loader2, PanelLeft, Play } from "@/icons";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { workspaceRowState } from "@/components/layout/cloud/rowState";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { NotSharedNotice } from "./CloudCollab";
import { DeletionProgress } from "./CloudWorkspaceLifecycle";
import { WorkspaceLifecycleDialog } from "./WorkspaceActions";
import { ExecutionLocation, WorkspaceView, describe, describeWorkspace, type OpenedWorkspace } from "./CloudWorkspaceView";
import { workspaceTargetKey, type CloudWorkspaceListItem } from "@/lib/api";
import { accessLostReason, clearCollabAccess } from "@/lib/cloudCollab";
import { closeCloudConnection, retainCloudConnection, setSelectedCloudConnection, subscribeCloudConnections, type CloudLease } from "@/lib/cloudConnections";
import { findCloudWorkspace, refreshCloudCatalog, resumeCloudWorkspace, useCloudCatalog } from "@/lib/cloudCatalog";
import { CloudResourceNotice } from "@/components/cloud/CloudResourceNotice";
import { archiving, deletion, isOpen, lastSavedText, lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { useCloudAgentRan } from "@/lib/cloudSessions";
import { detachCloudTerminals, errorCode } from "@/lib/cloudTerminals";
import { selectSession } from "@/lib/sessions";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "@/types/target";

const NOT_CONNECTED: WorkspaceConnectionState = { state: "idle" };

/** What selecting a workspace may do: connect to one that is running or stopped, never wake it; nothing while it starts, is deleted or needs attention. */
function openable(item: CloudWorkspaceListItem): boolean {
  return ["ready", "suspended", "archived"].includes(item.workspace.state) && !deletion(item) && !archiving(item);
}

/**
 * A cloud workspace in the main slot, with the sidebar kept (PRO-23 CS-5).
 * `workspaceKey` may also be a session key (`cloud:<org>:<workspace>:<session>`):
 * until the shared SessionView renders cloud sessions, a selected session
 * shows its workspace here. The connection is a lease from the connection
 * manager, so the sidebar's session list follows it live.
 *
 * The workspace view (terminals, agent, files, git). Selecting only looks: it connects with `connect`,
 * never `wake`, so a stopped workspace shows its saved agent conversations
 * and stays stopped until Resume is pressed.
 */
export function CloudWorkspaceMain({ workspaceKey, sidebarOpen, onToggleSidebar }: { workspaceKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const catalog = useCloudCatalog();
  const sections = useOrganizationVisibility();
  const parsed = parseCloudWorkspaceKey(workspaceKey);
  // Signed out, or no longer a member: nothing of the organization is shown or connected.
  const member = !!parsed && sections.live.has(parsed.orgId);
  const item = parsed && member ? findCloudWorkspace(catalog, parsed.orgId, parsed.workspaceId) : null;
  const org = parsed ? catalog.orgs[parsed.orgId] : undefined;
  // #497: the API refused `open` for access (a revoked share, a workspace made
  // private). The refusal is kept with its workspace. A list asked for after
  // it that names a role for this person opens it again, once: if that open is
  // refused too (a list that lags the runtime), only Check again retries, so a
  // refused open never loops with the list it asks for. A row without a role
  // (an older server) never opens it on its own.
  const [refused, setRefused] = useState<{ key: string; at: number; autoSpent: boolean } | null>(null);
  // The workspace whose last unlock was automatic or asked for, until a connect succeeds.
  const unlocked = useRef<string | null>(null);
  const refusal = refused?.key === workspaceKey ? refused : null;
  const listRequestedAt = org?.requestedAt ?? null;
  const listedRole = item?.workspace.you?.role;
  const sharedAgain = !!refusal && !refusal.autoSpent && !!listedRole && listedRole !== "none" && listRequestedAt !== null && listRequestedAt > refusal.at;
  const locked = !!refusal && !sharedAgain;
  const canOpen = !!item && openable(item) && !locked;
  // A stopped workspace that was resumed is reconnected, so the view follows it to running.
  const running = item?.workspace.state === "ready";
  // The lease, and through it the workspace's connection of now: the manager
  // replaces it when the workspace stops and comes back, and the view follows.
  const [held, setHeld] = useState<{ lease: CloudLease; name: string; provider: OpenedWorkspace["provider"]; workspaceState: OpenedWorkspace["workspaceState"] } | null>(null);
  const connection = useSyncExternalStore(subscribeCloudConnections, () => held?.lease.current() ?? null, () => null);
  const state = useSyncExternalStore<WorkspaceConnectionState>(subscribeCloudConnections, () => held?.lease.state() ?? NOT_CONNECTED, () => NOT_CONNECTED);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  // The list's state of now, so the view's chips follow a stop or a resume instead of what was true when it was opened.
  const listState = item?.workspace.state ?? null;
  // A resume is under way while this window's request is out, or while the list shows one running.
  // A refused one (the running limit) ends both, and the chips read stopped again.
  const waking = resuming || (!!item?.latestOperation && isOpen(item.latestOperation) && item.latestOperation.action === "resume");
  const opened = useMemo<OpenedWorkspace | null>(
    () => (held && connection ? { connection, name: held.name, provider: held.provider, workspaceState: listState ?? held.workspaceState, waking } : null),
    [held, connection, listState, waking],
  );
  // A retried delete the server refuses because work is still running: the delete dialog says what would be lost and asks.
  const [forcing, setForcing] = useState(false);

  useEffect(() => {
    if (!parsed || !item || !canOpen) return;
    let live = true;
    let lease: CloudLease | null = null;
    const key = cloudWorkspaceKey(parsed.orgId, parsed.workspaceId);
    setSelectedCloudConnection(key);
    setError(null);
    retainCloudConnection({ orgId: parsed.orgId, workspaceId: parsed.workspaceId }, "connect")
      .then((next) => {
        if (!live) return next.release();
        lease = next;
        setHeld({ lease: next, name: item.workspace.name, provider: item.workspace.provider, workspaceState: item.workspace.state });
      })
      .catch((e: unknown) => live && setError(errorCode(e)));
    return () => {
      live = false;
      setHeld(null);
      setSelectedCloudConnection(null);
      lease?.release();
    };
    // The workspace's identity and whether it runs decide the connection; row refreshes do not.
  }, [workspaceKey, canOpen, running]); // eslint-disable-line react-hooks/exhaustive-deps

  const refusedNow = state.state === "reconnecting" && accessLostReason(state.reason);
  useEffect(() => {
    if (!refusedNow) return;
    setRefused((current) => (current?.key === workspaceKey ? current : { key: workspaceKey, at: Date.now(), autoSpent: unlocked.current === workspaceKey }));
  }, [refusedNow, workspaceKey]);
  useEffect(() => {
    if (state.state === "connected") unlocked.current = null;
  }, [state.state]);
  useEffect(() => {
    if (!sharedAgain) return;
    unlocked.current = workspaceKey;
    setRefused(null);
  }, [sharedAgain, workspaceKey]);
  // Check again: one more open, whatever the list says; refused again, it locks again.
  const recheck = () => {
    if (!parsed) return;
    unlocked.current = workspaceKey;
    setRefused(null);
    void refreshCloudCatalog(parsed.orgId);
  };
  // Refused: close the connection, which would only retry `open` for ever, and read the list so the sidebar row follows.
  useEffect(() => {
    if (!locked || !parsed) return;
    const key = cloudWorkspaceKey(parsed.orgId, parsed.workspaceId);
    clearCollabAccess(key);
    detachCloudTerminals(key);
    closeCloudConnection({ orgId: parsed.orgId, workspaceId: parsed.workspaceId });
    void refreshCloudCatalog(parsed.orgId);
  }, [locked, workspaceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const resume = async () => {
    if (!item) return;
    setResuming(true);
    setError(null);
    try {
      // The explicit action: one resume, then the list follows it to running.
      await resumeCloudWorkspace(item);
      void refreshCloudCatalog(item.workspace.orgId);
    } catch (e) {
      setError(lifecycleErrorMessage(errorCode(e)));
    } finally {
      setResuming(false);
    }
  };

  const agentRan = useCloudAgentRan(item);
  const rowState = item ? workspaceRowState(item, agentRan) : null;
  const stopped = item?.workspace.state === "suspended";
  const saved = item ? lastSavedText(item) : null;
  const deleting = item ? deletion(item) : null;

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip" data-testid="cloud-workspace-main">
      <header
        data-tauri-drag-region="deep"
        className="flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-hairline px-2"
        style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
      >
        {!sidebarOpen && (
          <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
            <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
              <PanelLeft />
            </Button>
          </WithTooltip>
        )}
        <Cloud className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{item?.workspace.name ?? "Cloud workspace"}</span>
        {item && <ExecutionLocation provider={item.workspace.provider} name={item.workspace.name} />}
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground" data-testid="cloud-connection-state" title={item ? describeWorkspace(item, Date.now(), agentRan) : undefined}>
          {rowState?.label}
          {opened && state.state !== "idle" && state.state !== "suspended" ? ` · ${describe(state)}` : ""}
        </span>
        {stopped && (
          <Button size="sm" variant="outline" className="shrink-0" disabled={resuming} onClick={() => void resume()}>
            {resuming ? <Loader2 className="animate-spin" /> : <Play />} Resume
          </Button>
        )}
      </header>
      {stopped && (
        <div className="shrink-0 border-b border-hairline bg-well px-4 py-1.5 text-xs text-muted-foreground" role="status" data-testid="cloud-stopped-banner">
          Stopped. Saved agent conversations are shown; nothing runs until you resume it.
          {saved && <span data-testid="cloud-last-saved"> {saved}</span>}
        </div>
      )}
      {member && item && parsed && <CloudResourceNotice workspaceKey={cloudWorkspaceKey(parsed.orgId, parsed.workspaceId)} manage={state.state === "connected" && state.authority === "manage"} />}
      {error && <p className="shrink-0 px-4 py-1 text-xs text-destructive">Could not open: {error}</p>}
      {!member ? (
        <Centered>
          <span className="flex flex-col items-center gap-2">
            You no longer have access to this cloud workspace from here.
            <Button size="sm" variant="outline" onClick={() => selectSession(null)}>
              Back
            </Button>
          </span>
        </Centered>
      ) : locked && item && parsed ? (
        <NotSharedNotice kind="removed" onBack={() => selectSession(null)} onRecheck={recheck} />
      ) : !item && org?.fetchedAt ? (
        <Centered>This cloud workspace was deleted, or you no longer have access to it.</Centered>
      ) : !item ? (
        <Centered>
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading the workspace…
        </Centered>
      ) : deleting ? (
        <div className="p-4">
          <DeletionProgress item={item} onChanged={() => void refreshCloudCatalog(item.workspace.orgId)} onForceNeeded={() => setForcing(true)} />
          {forcing && <WorkspaceLifecycleDialog request={{ item, action: "delete" }} onClose={() => setForcing(false)} />}
        </div>
      ) : !canOpen ? (
        <Centered>{describeWorkspace(item)}</Centered>
      ) : opened ? (
        <WorkspaceView key={workspaceTargetKey(opened.connection.target)} opened={opened} state={state} />
      ) : (
        !error && (
          <Centered>
            <Loader2 className="mr-2 size-4 animate-spin" /> Checking the workspace…
          </Centered>
        )
      )}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">{children}</div>;
}
