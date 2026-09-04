import { useEffect, useState } from "react";
import { CalendarClock, CircleDot, FolderTree, GitBranch, MessageSquare, PanelLeft, PanelRight, Terminal, TerminalSquare } from "lucide-react";
import { toggleTabView, useTabViews } from "@/lib/tabViews";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { openAutomations, renameWorkspace, useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import type { SessionEntry } from "@/types/session";
import { TabView } from "./TabView";
import { tabPanelId, TabStrip } from "./TabStrip";
import { activateLatestTerminal, useTerminals, type SelectedSessionTab } from "@/lib/terminal";
import { TerminalView } from "@/components/terminal/TerminalView";
import { setLastFocused, useEditors } from "@/lib/editors";
import { EditorSplit } from "@/components/editor/EditorSplit";
import { QuickOpen } from "@/components/editor/QuickOpen";
import { ProjectSearch } from "@/components/editor/ProjectSearch";
import { ExplorerPane } from "@/components/files/ExplorerPane";
import { RightPanel } from "@/components/layout/RightPanel";
import { useTabLog } from "@/lib/agentEvents";
import type { TabEntry } from "@/types/session";
import { WorkspaceNameEditor } from "./WorkspaceNameEditor";
import { workspaceName } from "@/lib/dashboard";

function managedWorkspaceFor(session: SessionEntry) {
  if (!session.worktreeName || session.worktreeRemoved) return undefined;
  return { projectPath: session.projectPath, name: session.worktreeName };
}

/** The right panel reads the active tab's log for the changes range. */
function PanelHost({ session, tab }: { session: SessionEntry; tab: TabEntry }) {
  const log = useTabLog(session.id, tab.id);
  const live = tab.status === "in_progress" || tab.status === "waiting";
  const workspace = managedWorkspaceFor(session);
  return (
    <RightPanel
      cwd={session.cwd}
      branch={session.branch ?? null}
      baseRef={session.baseRef}
      events={log.events}
      version={log.version}
      live={live}
      sessionId={session.id}
      mentionTabId={session.activeTab ?? session.tabs[0]?.id ?? null}
      statusKey={session.tabs.map((item) => item.status).join(",")}
      settleSessionId={workspace ? session.id : undefined}
      workspace={workspace}
    />
  );
}

/**
 * One session: a header naming the place, a peer strip for agent and shell
 * tabs, the selected tab's full-height body, and the right panel.
 */
export function SessionView({
  session,
  sidebarOpen,
  onToggleSidebar,
}: {
  session: SessionEntry;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  const prefs = usePrefs();
  const store = useSessionStore();
  const project = store.projects.find((p) => p.path === session.projectPath);
  const terminals = useTerminals();
  const shellPanes = terminals.panes.filter((pane) => pane.sessionId === session.id && !pane.hidden);
  const requested = terminals.selected[session.id];
  const persistedAgent = session.tabs.find((tab) => tab.id === session.activeTab) ?? session.tabs[0];
  const selected: SelectedSessionTab | null =
    requested?.kind === "agent" && session.tabs.some((tab) => tab.id === requested.id)
      ? requested
      : requested?.kind === "terminal" && shellPanes.some((pane) => pane.id === requested.id)
        ? requested
        : persistedAgent
          ? { kind: "agent", id: persistedAgent.id }
          : shellPanes.length
            ? { kind: "terminal", id: shellPanes[0].id }
            : null;
  const activeTab = selected?.kind === "agent" ? session.tabs.find((tab) => tab.id === selected.id) : undefined;
  const activeShell = selected?.kind === "terminal" ? shellPanes.find((pane) => pane.id === selected.id) : undefined;
  const tabViews = useTabViews();
  const activeInTerminal = !!activeTab && tabViews.views[activeTab.id] === "terminal";
  const switching = !!activeTab && !!tabViews.switching[activeTab.id];
  const workspaceLabel = session.worktreeRemoved ? workspaceName(session) : session.branch;
  const workspaceTitle = session.removedWorkspace?.path ?? session.cwd;
  const [renameError, setRenameError] = useState<string | null>(null);
  const workspace = managedWorkspaceFor(session);
  useHotkey("mod+shift+t", () => {
    if (activeTab) void toggleTabView(session, activeTab);
  });
  const ed = useEditors();
  const hasEditors = ed.editors.some((e) => e.sessionId === session.id);
  // Agents change files when their status changes; the explorer re-reads git then.
  const statusKey = session.tabs.map((t) => t.status).join(",");

  useEffect(() => {
    if (session.tabs.length) return;
    if (!getPrefs().panelOpen) setPrefs({ panelOpen: true });
    void activateLatestTerminal(session.id, session.cwd).catch((e) => console.error("terminal open failed", e));
  }, [session.id, session.cwd, session.tabs.length]);

  useHotkey("mod+j", () => void activateLatestTerminal(session.id, session.cwd));

  useHotkey("mod+shift+e", () => setPrefs({ explorerOpen: !prefs.explorerOpen }));

  return (
    <div className="flex h-full min-w-0 flex-1">
      {prefs.explorerOpen && (
        <ExplorerPane sessionId={session.id} root={session.cwd} rootName={project?.name ?? "project"} mentionTabId={activeTab?.id ?? null} statusKey={statusKey} />
      )}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2"
          style={{ paddingLeft: sidebarOpen || prefs.explorerOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && !prefs.explorerOpen && (
            <WithTooltip label="Show sidebar" keys={keycaps("mod+b")}>
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-sm">
            <span className="shrink-0 text-muted-foreground">{project?.name ?? "project"}</span>
            <span className="text-faint">/</span>
            <span className="truncate text-foreground" title={session.title}>
              {session.title}
            </span>
            {session.issue && (
              <WithTooltip label={session.issue.title}>
                <button
                  type="button"
                  onClick={() => void openUrl(session.issue!.url)}
                  className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CircleDot className="size-3" />
                  {session.issue.identifier}
                </button>
              </WithTooltip>
            )}
            {session.automation && (
              <WithTooltip label={`Open ${session.automation.name} in Automations`}>
                <button
                  type="button"
                  onClick={openAutomations}
                  className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <CalendarClock className="size-3" />
                  {session.automation.name} #{session.automation.runNumber}
                </button>
              </WithTooltip>
            )}
            {workspaceLabel && (
              <span className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground" title={workspaceTitle}>
                <GitBranch className="size-3" />
                {session.worktreeName && !session.worktreeRemoved ? (
                  <WorkspaceNameEditor
                    value={session.worktreeName}
                    onCommit={async (requested) => {
                      const renamed = await renameWorkspace(session.projectPath, session.cwd, requested);
                      return renamed.name;
                    }}
                    onError={setRenameError}
                    className="max-w-52 text-muted-foreground hover:text-foreground"
                  />
                ) : (
                  workspaceLabel
                )}
                {session.worktreeRemoved && <span className="text-faint">· workspace removed</span>}
              </span>
            )}
            {renameError && (
              <span role="alert" className="ml-1 max-w-64 truncate text-[11px] text-destructive" title={renameError}>
                {renameError}
              </span>
            )}
          </div>

          <div className="ml-auto flex min-w-0 max-w-[70%] items-center gap-0.5">
            <TabStrip session={session} selected={selected} />
            {activeTab && (
              <WithTooltip label={activeInTerminal ? "Back to chat" : "Show terminal view"} keys={keycaps("mod+shift+t")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={activeInTerminal ? "Back to chat" : "Show terminal view"}
                  aria-pressed={activeInTerminal}
                  disabled={switching}
                  onClick={() => void toggleTabView(session, activeTab)}
                  className={cn(activeInTerminal && "bg-veil-strong text-foreground")}
                >
                  {activeInTerminal ? <MessageSquare /> : <Terminal />}
                </Button>
              </WithTooltip>
            )}
            <WithTooltip label={prefs.explorerOpen ? "Hide explorer" : "Show explorer"} keys={keycaps("mod+shift+e")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle explorer"
                onClick={() => setPrefs({ explorerOpen: !prefs.explorerOpen })}
              >
                <FolderTree />
              </Button>
            </WithTooltip>
            <WithTooltip label="Terminal" keys={keycaps("mod+j")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Terminal"
                onClick={() => void activateLatestTerminal(session.id, session.cwd)}
              >
                <TerminalSquare />
              </Button>
            </WithTooltip>
            <WithTooltip label={prefs.panelOpen ? "Hide panel" : "Show panel"} keys={keycaps("mod+e")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle panel"
                onClick={() => setPrefs({ panelOpen: !prefs.panelOpen })}
              >
                <PanelRight />
              </Button>
            </WithTooltip>
          </div>
        </header>

        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <div
              className="relative flex h-full min-w-0 flex-1 flex-col"
              onPointerDownCapture={() => setLastFocused("chat")}
              onFocusCapture={() => setLastFocused("chat")}
            >
              {session.tabs.map((t) => (
                <div
                  key={t.id}
                  id={tabPanelId({ kind: "agent", id: t.id })}
                  role="tabpanel"
                  aria-labelledby={`session-agent-tab-${encodeURIComponent(t.id)}`}
                  aria-hidden={selected?.kind !== "agent" || t.id !== selected.id}
                  className={cn("flex min-h-0 flex-1 flex-col", (selected?.kind !== "agent" || t.id !== selected.id) && "hidden")}
                >
                  <TabView session={session} tab={t} active={selected?.kind === "agent" && t.id === selected.id} />
                </div>
              ))}
              {shellPanes.map((pane) => (
                <div
                  key={pane.id}
                  id={tabPanelId({ kind: "terminal", id: pane.id })}
                  role="tabpanel"
                  aria-labelledby={`session-terminal-tab-${encodeURIComponent(pane.id)}`}
                  aria-hidden={selected?.kind !== "terminal" || pane.id !== selected.id}
                  className={cn("absolute inset-0", (selected?.kind !== "terminal" || pane.id !== selected.id) && "invisible")}
                >
                  <TerminalView id={pane.id} visible={pane.id === activeShell?.id} />
                  {pane.exited && (
                    <div className="absolute bottom-2 left-3 rounded-md bg-popover px-2 py-1 text-[11px] text-muted-foreground hairline">
                      Process exited{pane.exitCode != null ? ` (${pane.exitCode})` : ""}.
                    </div>
                  )}
                </div>
              ))}
              {!session.tabs.length && !shellPanes.length && (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
                  <span>Workspace open</span>
                  <span className="text-xs text-faint">Open a new terminal or add an agent tab.</span>
                </div>
              )}
            </div>
            {hasEditors && <EditorSplit sessionId={session.id} active />}
          </div>
        </section>
      </div>

      {prefs.panelOpen &&
        (activeTab ? (
          <PanelHost session={session} tab={activeTab} />
        ) : (
          <RightPanel
            cwd={session.cwd}
            branch={session.branch ?? null}
            workingTree
            sessionId={session.id}
            statusKey={statusKey}
            rootName={project?.name ?? "project"}
            settleSessionId={workspace ? session.id : undefined}
            workspace={workspace}
          />
        ))}
      <QuickOpen sessionId={session.id} root={session.cwd} />
      <ProjectSearch sessionId={session.id} root={session.cwd} />
    </div>
  );
}
