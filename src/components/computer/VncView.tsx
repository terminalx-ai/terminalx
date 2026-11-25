import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import type { RawChannel } from "@novnc/novnc";
import { cn } from "@/lib/cn";

export type VncState = "connecting" | "connected" | "disconnected";

/**
 * A live view of a VNC desktop served by noVNC's websockify on loopback,
 * scaled to fit. Watching only unless `control` is on; then the pointer and
 * keys go to the desktop.
 */
export function VncView({
  port,
  password,
  openChannel,
  control,
  attempt = 0,
  onState,
  className,
}: {
  port?: number;
  password?: string;
  openChannel?: () => RawChannel;
  control: boolean;
  /** Bumped to connect again after a drop. */
  attempt?: number;
  onState?: (state: VncState) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [state, setState] = useState<VncState>("connecting");
  const report = useRef(onState);
  report.current = onState;

  useEffect(() => {
    const target = host.current;
    if (!target) return;
    let gone = false;
    let channel: RawChannel | undefined;
    const set = (next: VncState) => {
      if (gone) return;
      setState(next);
      report.current?.(next);
    };
    set("connecting");
    // Loaded when first shown: the client is only needed by someone who opens the tab.
    void import("@novnc/novnc")
      .then(({ default: Client }) => {
        if (gone) return;
        channel = openChannel?.();
        const client = new Client(target, channel ?? `ws://127.0.0.1:${port}/websockify`, { credentials: { password }, shared: true });
        if (channel) {
          client.qualityLevel = 4;
          client.compressionLevel = 6;
        }
        client.scaleViewport = true;
        client.resizeSession = false;
        client.background = "transparent";
        client.viewOnly = true;
        client.addEventListener("connect", () => set("connected"));
        client.addEventListener("disconnect", () => set("disconnected"));
        client.addEventListener("credentialsrequired", () => client.sendCredentials({ password }));
        rfb.current = client;
      })
      .catch(() => { channel?.close(); set("disconnected"); });
    return () => {
      gone = true;
      rfb.current?.disconnect();
      channel?.close();
      rfb.current = null;
      target.replaceChildren();
    };
  }, [port, password, openChannel, attempt]);

  useEffect(() => {
    const client = rfb.current;
    if (!client) return;
    client.viewOnly = !control;
    if (control) client.focus();
  }, [control, state]);

  return <div ref={host} data-testid="vnc-view" data-state={state} className={cn("h-full w-full overflow-hidden", !control && "cursor-default", className)} />;
}
