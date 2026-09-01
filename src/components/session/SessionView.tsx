import { GitBranch, PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { keycaps } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";
import { useSessionStore } from "@/lib/sessions";
import { cn } from "@/lib/cn";
import type { SessionEntry } from "@/types/session";
import { TabView } from "./TabView";
import { TabStrip } from "./TabStrip";

/**
 * One session: a header naming the place, a tab strip (one tab per agent
 * conversation), the active tab's body, and the right panel.
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
  const activeTab = session.tabs.find((t) => t.id === session.activeTab) ?? session.tabs[0];

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2"
          style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && (
            <WithTooltip label="Show sidebar" keys={keycaps("mod+b")}>
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          <div className="flex min-w-0 items-center gap-1.5 px-1 text-sm">
            <span className="shrink-0 text-muted-foreground">{project?.name ?? "project"}</span>
            <span className="text-faint">/</span>
            <span className="truncate text-foreground" title={session.title}>
              {session.title}
            </span>
            {session.branch && (
              <span className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground" title={session.cwd}>
                <GitBranch className="size-3" />
                {session.branch}
              </span>
            )}
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-0.5">
            <TabStrip session={session} activeTab={activeTab} />
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
          {session.tabs.map((t) => (
            <div key={t.id} className={cn("flex min-h-0 flex-1 flex-col", t.id !== activeTab?.id && "hidden")}>
              <TabView session={session} tab={t} active={t.id === activeTab?.id} />
            </div>
          ))}
          {!session.tabs.length && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">No tabs.</div>
          )}
        </section>
      </div>

      {prefs.panelOpen && (
        <aside className="flex h-full w-(--panel-w) shrink-0 flex-col border-l border-hairline">
          <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2">
            <span className="px-1 text-xs font-medium text-muted-foreground">Changes</span>
          </div>
          <div className="flex-1 p-4 text-xs text-muted-foreground">Nothing to show yet.</div>
        </aside>
      )}
    </div>
  );
}
