import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Cloud, Loader2, PanelLeft, Play } from "lucide-react";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { workspaceRowState } from "@/components/layout/cloud/rowState";
import { useCloudSections } from "@/components/layout/cloud/CloudSections";
import { DeletionProgress } from "./CloudWorkspaceLifecycle";
import { ExecutionLocation, WorkspaceView, describe, describeWorkspace, type OpenedWorkspace } from "./CloudSessionPage";
import { workspaceTargetKey, type CloudWorkspaceListItem } from "@/lib/api";
import { retainCloudConnection, setSelectedCloudConnection, subscribeCloudConnections, type CloudLease } from "@/lib/cloudConnections";
import { findCloudWorkspace, refreshCloudCatalog, resumeCloudWorkspace, useCloudCatalog } from "@/lib/cloudCatalog";
import { archiving, deletion, lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { errorCode } from "@/lib/cloudTerminals";
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
 * the existing workspace view (terminals, agent, files, git) of the
 * full-window cloud page. Selecting only looks: it connects with `connect`,
 * never `wake`, so a stopped workspace shows its saved agent conversations
 * and stays stopped until Resume is pressed.
 */
export function CloudWorkspaceMain({ workspaceKey, sidebarOpen, onToggleSidebar }: { workspaceKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const catalog = useCloudCatalog();
  const sections = useCloudSections();
  const parsed = parseCloudWorkspaceKey(workspaceKey);
  // Signed out, or no longer a member: nothing of the organization is shown or connected.
  const member = !!parsed && sections.live.has(parsed.orgId);
  const item = parsed && member ? findCloudWorkspace(catalog, parsed.orgId, parsed.workspaceId) : null;
  const canOpen = !!item && openable(item);
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
  const opened = useMemo<OpenedWorkspace | null>(
    () => (held && connection ? { connection, name: held.name, provider: held.provider, workspaceState: listState ?? held.workspaceState, waking: resuming } : null),
    [held, connection, listState, resuming],
  );

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

  const rowState = item ? workspaceRowState(item) : null;
  const stopped = item?.workspace.state === "suspended";
  const deleting = item ? deletion(item) : null;
  const org = parsed ? catalog.orgs[parsed.orgId] : undefined;

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
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground" data-testid="cloud-connection-state" title={item ? describeWorkspace(item) : undefined}>
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
        </div>
      )}
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
      ) : !item && org?.fetchedAt ? (
        <Centered>This cloud workspace was deleted, or you no longer have access to it.</Centered>
      ) : !item ? (
        <Centered>
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading the workspace…
        </Centered>
      ) : deleting ? (
        <div className="p-4">
          <DeletionProgress item={item} onChanged={() => void refreshCloudCatalog(item.workspace.orgId)} onForceNeeded={() => undefined} />
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
