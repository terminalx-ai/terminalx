import { useEffect, useState } from "react";
import { ExternalLink, Globe, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { api, type CloudWorkspaceAgentBrowser, type CloudWorkspaceListItem } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { useCloudBrowserOffer } from "@/lib/cloudBrowser";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { phase2Ready } from "@/lib/phase2Readiness";
import { openOrganizationSettings } from "@/lib/settingsLinks";
import { cloudWorkspaceKey } from "@/types/target";

const ABOUT = "Agents in this workspace’s tabs can open pages, click and type in Chrome on the cloud desktop. Tabs that ask show one approval per browser session.";

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** "On · turned on by you, 10:28", "On · turned on by Fixture Person". */
export function enabledLine(state: CloudWorkspaceAgentBrowser, viewerUserId: string | undefined): string {
  const by = state.enabledBy;
  if (!by) return "On";
  if (by.userId === viewerUserId) {
    const at = state.enabledAt ? new Date(state.enabledAt) : null;
    const time = at && !Number.isNaN(at.getTime()) ? `, ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    return `On · turned on by you${time}`;
  }
  return by.name?.trim() ? `On · turned on by ${by.name.trim()}` : "On";
}

/**
 * The workspace details card's "Cloud browser for agents" switch (PRO-209).
 * Off by default; only the workspace owner and admins can change it.
 */
export function CloudAgentBrowserSwitch({ item }: { item: CloudWorkspaceListItem }) {
  const { status } = useAccount();
  const w = item.workspace;
  const ready = phase2Ready(status, w.orgId, "agentBrowser");
  const viewerUserId = useCloudCatalog().viewerUserId;
  const offer = useCloudBrowserOffer(cloudWorkspaceKey(w.orgId, w.id));
  const [state, setState] = useState<CloudWorkspaceAgentBrowser | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The server holds it while the workspace's desktop rollout is held.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let live = true;
    setState(null); setFailure(null); setHeld(false);
    if (!ready) return;
    api.cloudWorkspaceAgentBrowser(w.id, w.orgId)
      .then((next) => { if (live) setState(next); })
      .catch((error) => {
        if (!live) return;
        if (errorCode(error) === "cloud_workspace_agent_browser_unavailable") setHeld(true);
        else setFailure("Unavailable right now.");
      });
    return () => { live = false; };
  }, [ready, w.id, w.orgId]);
  if (!ready || held) return null;

  const missing = offer === "packages-missing";
  const set = async (enabled: boolean) => {
    setBusy(true); setFailure(null);
    try { setState(await api.cloudWorkspaceAgentBrowser(w.id, w.orgId, enabled)); }
    catch (error) {
      setFailure(errorCode(error) === "cloud_workspace_agent_browser_forbidden"
        ? "Only the workspace owner and admins can change this." : "Could not change it. Try again.");
    } finally { setBusy(false); }
  };
  const on = !!state?.enabled && !missing;
  const line = !state ? (failure ?? "Loading…")
    : missing ? "Not offered · this environment has no desktop packages"
      : state.enabled ? enabledLine(state, viewerUserId) : "Off · agents here can’t use the desktop’s browser";

  return <section aria-label="Agent tools" className="space-y-2 border-t border-hairline pt-3" data-testid="agent-tools">
    <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Agent tools</h4>
    <div className="flex items-start gap-2">
      <Globe className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p id={`agent-browser-${w.id}`} className="font-medium text-foreground">Cloud browser for agents</p>
        <p role="status" data-testid="agent-browser-state"
          className={missing ? "flex items-start gap-1 text-warning" : on ? "flex items-center gap-1.5 text-success" : "text-muted-foreground"}>
          {missing && <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />}
          {on && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />}
          <span>{line}</span>
        </p>
      </div>
      <Switch size="md" aria-labelledby={`agent-browser-${w.id}`} checked={on}
        disabled={!state || busy || missing || !state.canChange} onCheckedChange={(next) => void set(next)} />
    </div>
    <p className="text-muted-foreground">{ABOUT}</p>
    {missing && <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2" data-testid="agent-browser-missing">
      <p>This environment was built without the Linux desktop and Chrome. Add them in Cloud compute › Environment, then restart the workspace.</p>
      <Button size="xs" variant="outline" onClick={() => openOrganizationSettings(w.orgId)}><ExternalLink /> Open Cloud compute</Button>
    </div>}
    {state && !state.canChange && <p className="text-muted-foreground">Only the workspace owner and admins can change this.</p>}
    {state && failure && <p role="alert" className="text-destructive">{failure}</p>}
  </section>;
}
