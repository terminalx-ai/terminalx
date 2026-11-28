import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, Info, Loader2, Lock, Monitor, PauseCircle, Sparkles } from "@/icons";
import { VncView, type VncState } from "@/components/computer/VncView";
import { CloudDesktopChannel } from "@/lib/cloudDesktopChannel";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { CloudDesktopAgent } from "@/lib/cloudBrowser";

export function CloudDesktopPane({ client, asleep, control, visible = true, agent = null, onReconnect }: {
  client: CloudSessionModel["client"];
  asleep: boolean;
  control: boolean;
  visible?: boolean;
  /** An agent driving the desktop's browser (PRO-209): local input is not sent meanwhile. */
  agent?: CloudDesktopAgent | null;
  onReconnect: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<VncState>("connecting");
  const [watchFallback, setWatchFallback] = useState<typeof client>(null);
  const effectiveControl = control && watchFallback !== client;
  const [failure, setFailure] = useState<"image" | "access" | "chrome" | null>(null);
  const open = useCallback(() => new CloudDesktopChannel(client!, effectiveControl, (error) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "cloud_desktop_image_unavailable") setFailure("image");
    if (code === "cloud_desktop_chrome_start_failed") setFailure("chrome");
    if (code === "forbidden") {
      if (effectiveControl) {
        setWatchFallback(client);
        setState("connecting");
        return;
      }
      setFailure("access");
    }
    setState("disconnected");
  }), [client, effectiveControl]);

  const online = client?.connection.state === "connected";
  const available = online && client?.hasCapability("cloud-desktop/1");
  const reconnect = () => {
    setFailure(null);
    setState("connecting");
    setAttempt((previous) => previous + 1);
    if (!online) onReconnect();
  };

  const watchOnly = available && !effectiveControl;
  const [handing, setHanding] = useState(false);
  // Take control pauses the agent; it waits until the desktop is handed back.
  const hand = async (method: "desktop.takeControl" | "desktop.handBack") => {
    if (!client) return;
    setHanding(true);
    try { await client.call(method, {}); } catch { /* the next desktop.agent says where it stands */ } finally { setHanding(false); }
  };
  const driving = available && !asleep && agent && !agent.held ? agent : null;
  const message = asleep ? "Workspace stopped" : failure === "image" ? "Not available in this workspace image."
    : failure === "chrome" ? "Chrome could not start in this workspace image."
    : failure === "access" ? "Cloud desktop access is unavailable." : online && !available ? "Cloud desktop is unavailable in this runtime."
    : !online || state === "disconnected" ? "Disconnected" : "Connecting…";
  const connecting = message === "Connecting…";
  const Icon = asleep ? PauseCircle : failure === "access" ? Lock : connecting ? Loader2 : Monitor;

  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="cloud-desktop">
    {watchOnly && <div className="flex items-center gap-2 border-b border-hairline px-3 py-2 text-xs text-muted-foreground">
      <Eye className="size-3.5 shrink-0" aria-hidden />
      <span>You need edit access to use the cloud desktop</span>
    </div>}
    {available && !asleep && agent && <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-1.5 text-xs" data-testid="cloud-desktop-agent">
      <span role="status" className={agent.held ? "flex items-center gap-1.5 text-muted-foreground" : "flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-2 py-0.5 text-accent"}>
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        {agent.held ? <span>You have control · {agent.agent} waits</span>
          : <span><span className="font-medium">{agent.agent} is driving</span>{agent.tabTitle && <span className="text-muted-foreground"> · tab {agent.tabTitle}</span>}</span>}
      </span>
      {effectiveControl && <Button size="xs" variant={agent.held ? "outline" : "default"} className="ml-auto" disabled={handing}
        onClick={() => void hand(agent.held ? "desktop.handBack" : "desktop.takeControl")}>{agent.held ? "Hand back" : "Take control"}</Button>}
    </div>}
    {driving && <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-veil-raised px-3 py-1.5 text-xs text-muted-foreground">
      <Info className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">Your clicks and keys are not sent while {driving.agent} drives. Take control to stop it; it waits until you hand the desktop back.</span>
      {driving.action && <span className="shrink-0 text-accent" data-testid="cloud-desktop-agent-action">{driving.action} · action {driving.actions}</span>}
    </div>}
    {available && !asleep && !failure && <VncView key={String(effectiveControl)} openChannel={open} control={visible && effectiveControl && !driving} attempt={attempt} onState={setState}
      className="min-h-0 flex-1" />}
    {(asleep || !available || state !== "connected" || failure) &&
      <div className={`absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground ${watchOnly ? "top-9" : ""}`}>
        <Icon className={`size-5 ${connecting ? "animate-spin" : ""}`} aria-hidden />
        <p role="status" className="font-medium text-foreground">{message}</p>
        {!asleep && (!online || (available && state === "disconnected" && failure !== "image")) &&
          <Button size="sm" variant="outline" onClick={reconnect}>Reconnect</Button>}
      </div>}
  </div>;
}
