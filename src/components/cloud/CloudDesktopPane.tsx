import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { VncView, type VncState } from "@/components/computer/VncView";
import { CloudDesktopChannel } from "@/lib/cloudDesktopChannel";
import type { CloudSessionModel } from "@/lib/cloudSession";

export function CloudDesktopPane({ client, asleep, control, onReconnect }: {
  client: CloudSessionModel["client"];
  asleep: boolean;
  control: boolean;
  onReconnect: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<VncState>("connecting");
  const [failure, setFailure] = useState<"image" | "access" | "chrome" | null>(null);
  const open = useCallback(() => new CloudDesktopChannel(client!, control, (error) => {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "cloud_desktop_image_unavailable") setFailure("image");
    if (code === "cloud_desktop_chrome_start_failed") setFailure("chrome");
    if (code === "forbidden") setFailure("access");
    setState("disconnected");
  }), [client, control]);

  const online = client?.connection.state === "connected";
  const available = online && client?.hasCapability("cloud-desktop/1");
  const reconnect = () => {
    setFailure(null);
    setState("connecting");
    setAttempt((previous) => previous + 1);
    if (!online) onReconnect();
  };

  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="cloud-desktop">
    <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2 text-xs text-muted-foreground">
      <span>Linux desktop</span>
      {available && !control && <span>You need edit access to use the cloud desktop</span>}
    </div>
    {available && !asleep && !failure && <VncView openChannel={open} control={control} attempt={attempt} onState={setState}
      className="min-h-0 flex-1" />}
    {(asleep || !available || state !== "connected" || failure) &&
      <div className="absolute inset-0 top-9 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <p role="status">{asleep ? "The workspace is stopped." : failure === "image" ? "Not available in this workspace image."
          : failure === "chrome" ? "Chrome could not start in this workspace image."
          : failure === "access" ? "Cloud desktop access is unavailable." : online && !available ? "Cloud desktop is unavailable in this runtime."
          : !online || state === "disconnected" ? "Disconnected" : "Connecting…"}</p>
        {!asleep && (!online || (available && state === "disconnected" && failure !== "image")) &&
          <Button size="sm" variant="outline" onClick={reconnect}>Reconnect</Button>}
      </div>}
  </div>;
}
