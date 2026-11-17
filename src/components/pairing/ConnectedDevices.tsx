import { Smartphone } from "@/icons";
import { Button } from "@/components/ui/button";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { disconnectDevice } from "@/lib/pairing";
import type { PairedDevice } from "@/types/pairing";

export function ConnectedDevices({ devices, busy, error }: { devices: PairedDevice[]; busy: boolean; error: string | null }) {
  const privacy = useDataPrivacy();
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto px-3 py-2.5">
      {devices.length === 0 ? (
        <p className="text-xs text-muted-foreground">No devices connected</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Connected phones can see and drive sessions on this Mac.</p>
          <ul className="flex flex-col gap-1.5">
            {devices.map((device, index) => {
              const name = privacy.enabled ? `Phone ${index + 1}` : device.label;
              return (
                <li key={device.id} className="flex items-center gap-2 rounded-md border border-hairline bg-veil-card px-2.5 py-1.5">
                  <Smartphone className="size-3.5 shrink-0 text-add" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={name}>{name}</span>
                  <Button variant="outline" size="xs" className="shrink-0" aria-label={`Disconnect ${name}`} disabled={busy} onClick={() => void disconnectDevice(device.id)}>
                    Disconnect
                  </Button>
                </li>
              );
            })}
          </ul>
          {error && <p role="alert" className="text-xs text-destructive">{privacy.enabled ? "Could not disconnect the device." : error}</p>}
        </>
      )}
    </div>
  );
}
