import { useEffect, useState } from "react";
import { Cloud, PanelLeft, Plug, Unplug } from "lucide-react";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { TITLEBAR_INSET } from "@/components/layout/AppShell";
import { TreeGroup, TreeRow, TreeToggle } from "@/components/layout/SidebarRows";
import { useSectionCollapsed } from "@/components/layout/cloud/CloudSections";
import { ExecutionLocation, WorkspaceView, describe } from "./CloudWorkspaceView";
import { workspaceTargetKey } from "@/lib/api";
import { DEV_RUNTIME_KEY, attachDevRuntime, detachDevRuntime, devRuntimeAvailable, useDevRuntime } from "@/lib/devRuntime";
import { selectCloudWorkspace, useSessionStore } from "@/lib/sessions";

const NAME = "Development runtime";

/**
 * Debug builds only: the sidebar's Development section. Attaches to a local
 * `terminalx-serve --relay-link` runtime by its pairing code; nothing here
 * exists in a release build.
 */
export function DevelopmentSection() {
  const store = useSessionStore();
  const connection = useDevRuntime();
  const [collapsed, toggle] = useSectionCollapsed("development", true);
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!devRuntimeAvailable()) return null;
  const attach = async () => {
    setError(null);
    setBusy(true);
    try {
      await attachDevRuntime(pairingCode);
      setPairingCode("");
    } catch (e) {
      setError((e as { code?: string }).code ?? "unknown");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="treeitem" aria-label="Development" aria-expanded={!collapsed} className="mt-3 min-w-0" data-testid="dev-runtime-section">
      <div data-tree-row className="relative flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 hover:bg-selected/40" title="Debug builds only">
        <TreeToggle expanded={!collapsed} label="Development" onToggle={toggle} />
        <button
          type="button"
          onClick={toggle}
          className="min-w-0 flex-1 truncate rounded-sm text-left text-[11px] font-medium uppercase tracking-wide text-faint outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Development
        </button>
      </div>
      <TreeGroup expanded={!collapsed} className="min-w-0 pl-2">
        {connection && (
          <div role="treeitem" aria-label={NAME} aria-selected={store.selectedCloudWorkspace === DEV_RUNTIME_KEY} className="min-w-0">
            <TreeRow level="item" selected={store.selectedCloudWorkspace === DEV_RUNTIME_KEY}>
              <Cloud className="ml-1.5 size-3 shrink-0 text-faint" aria-hidden />
              <button
                type="button"
                onClick={() => selectCloudWorkspace(DEV_RUNTIME_KEY)}
                className="min-w-0 flex-1 truncate rounded-sm py-1 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {NAME}
              </button>
              <WithTooltip label="Disconnect">
                <Button variant="ghost" size="icon-xs" aria-label="Disconnect the development runtime" onClick={detachDevRuntime}>
                  <Unplug />
                </Button>
              </WithTooltip>
            </TreeRow>
          </div>
        )}
        <form
          className="flex min-w-0 items-center gap-1 px-1.5 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (pairingCode.trim() && !busy) void attach();
          }}
        >
          <input
            aria-label="Pairing code"
            className="h-6 min-w-0 flex-1 rounded-sm border border-hairline bg-transparent px-1.5 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="pairing code"
            title="For a local terminalx-serve --relay-link runtime"
          />
          <Button type="submit" size="xs" variant="outline" className="h-6 shrink-0 px-1.5 text-[11px]" disabled={!pairingCode.trim() || busy}>
            <Plug /> Attach
          </Button>
        </form>
        {error && (
          <p className="px-1.5 text-[10px] text-destructive" role="alert">
            Could not attach: {error}
          </p>
        )}
      </TreeGroup>
    </div>
  );
}

/** The attached development runtime in the main slot, with the sidebar kept. */
export function DevRuntimeMain({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const connection = useDevRuntime();
  const [state, setState] = useState<WorkspaceConnectionState>({ state: "idle" });
  useEffect(() => {
    if (!connection) return;
    setState({ state: "idle" });
    return connection.client.onState(setState);
  }, [connection]);
  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip" data-testid="dev-runtime-main">
      <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-hairline px-2" style={{ paddingLeft: sidebarOpen ? 8 : TITLEBAR_INSET }}>
        {!sidebarOpen && (
          <WithTooltip label="Show sidebar" shortcut="app.toggleSidebar">
            <Button variant="ghost" size="icon-sm" aria-label="Show sidebar" onClick={onToggleSidebar}>
              <PanelLeft />
            </Button>
          </WithTooltip>
        )}
        <Cloud className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{NAME}</span>
        {connection && <ExecutionLocation provider={null} name={NAME} />}
        <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground" data-testid="cloud-connection-state">
          {connection ? describe(state) : "Not attached"}
        </span>
      </header>
      {connection ? (
        <WorkspaceView key={workspaceTargetKey(connection.target)} opened={{ connection, name: NAME, provider: null, workspaceState: null }} state={state} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">Attach a development runtime from the sidebar's Development section.</div>
      )}
    </main>
  );
}
