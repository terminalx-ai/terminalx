import { useCallback, useState } from "react";
import { PanelLeft, PanelRight, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { cn } from "@/lib/cn";
import { keycaps, useHotkey } from "@/lib/hotkeys";
import { setPrefs, usePrefs } from "@/lib/prefs";

export const TITLEBAR_INSET = 78; // traffic-light clearance, px

/**
 * Three columns under one drag strip: sidebar, workspace, optional right panel.
 * The title bar is ours (overlay style), so every column draws its own strip of
 * height --titlebar-h and the whole strip is a deep drag region.
 */
export function AppShell() {
  const prefs = usePrefs();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggleSidebar = useCallback(() => setPrefs({ sidebarOpen: !prefs.sidebarOpen }), [prefs.sidebarOpen]);
  const togglePanel = useCallback(() => setPrefs({ panelOpen: !prefs.panelOpen }), [prefs.panelOpen]);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+e", togglePanel);
  useHotkey("mod+,", openSettings);

  const sidebarOpen = prefs.sidebarOpen;
  const panelOpen = prefs.panelOpen;

  return (
    <div className="flex h-full w-full">
      <aside
        className={cn(
          "flex h-full shrink-0 flex-col border-r border-hairline transition-[width] duration-150",
          sidebarOpen ? "w-(--sidebar-w)" : "w-0 overflow-hidden border-r-0",
        )}
      >
        <div
          data-tauri-drag-region="deep"
          className="flex h-(--titlebar-h) shrink-0 items-center justify-end gap-0.5 pr-2"
          style={{ paddingLeft: TITLEBAR_INSET }}
        >
          <WithTooltip label="Settings" keys={keycaps("mod+,")}>
            <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSettings}>
              <Settings />
            </Button>
          </WithTooltip>
          <WithTooltip label="Hide sidebar" keys={keycaps("mod+b")}>
            <Button variant="ghost" size="icon-sm" aria-label="Hide sidebar" onClick={toggleSidebar}>
              <PanelLeft />
            </Button>
          </WithTooltip>
        </div>
        <div className="flex flex-col gap-1 px-2">
          <Button variant="ghost" className="justify-start gap-2 px-2 text-foreground">
            <Plus />
            New session
          </Button>
        </div>
        <div className="mt-3 px-3 text-[11px] font-medium uppercase tracking-wide text-faint">Sessions</div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1">
          <div className="rounded-md px-2 py-6 text-center text-xs text-muted-foreground">
            No sessions yet. Start one to open a worktree.
          </div>
        </div>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region="deep"
          className="flex h-(--titlebar-h) shrink-0 items-center gap-1 border-b border-hairline px-2"
          style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}
        >
          {!sidebarOpen && (
            <WithTooltip label="Show sidebar" keys={keycaps("mod+b")}>
              <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={toggleSidebar}>
                <PanelLeft />
              </Button>
            </WithTooltip>
          )}
          <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">New session</span>
          <WithTooltip label={panelOpen ? "Hide panel" : "Show panel"} keys={keycaps("mod+e")}>
            <Button variant="ghost" size="icon-sm" aria-label="Toggle panel" onClick={togglePanel}>
              <PanelRight />
            </Button>
          </WithTooltip>
        </header>
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="text-2xl font-semibold tracking-tight">Raccoon</div>
              <p className="mt-1 text-sm text-muted-foreground">A workbench for your coding agents.</p>
            </div>
          </div>
        </section>
      </main>

      {panelOpen && (
        <aside className="flex h-full w-(--panel-w) shrink-0 flex-col border-l border-hairline">
          <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 px-2">
            <span className="px-1 text-xs font-medium text-muted-foreground">Changes</span>
          </div>
          <div className="flex-1 p-4 text-xs text-muted-foreground">Nothing to show yet.</div>
        </aside>
      )}

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
