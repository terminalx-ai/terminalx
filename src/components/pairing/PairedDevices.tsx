import { Smartphone, TabletSmartphone } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { disconnectDevice, revokePairing, usePairing } from "@/lib/pairing";
import type { PairedDevice } from "@/types/pairing";
import { deviceStatus } from "./pairingText";

/** Devices still paired with this Mac: revoked ones are kept by the registry only as a record. */
export function pairedDevices(devices: PairedDevice[]): PairedDevice[] {
  return devices.filter((device) => !device.revokedAt);
}

function isTablet(device: PairedDevice): boolean {
  return /ipad|tablet/i.test(`${device.label} ${device.platform}`);
}

/** One paired device: name, how it is (or was last) connected, its fingerprint, and what can be done to it. */
export function PairedDeviceRow({ device, busy }: { device: PairedDevice; busy: boolean }) {
  const Icon = isTablet(device) ? TabletSmartphone : Smartphone;
  return (
    <li data-testid="paired-device" className="flex h-14 items-center gap-3 border-b border-hairline px-4 last:border-b-0">
      <Icon className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 leading-4">
        <div className="truncate text-[13px]">{device.label}</div>
        <div className={cn("truncate text-[11.5px]", device.connection ? "text-add" : "text-faint")}>{deviceStatus(device)}</div>
      </div>
      {device.fingerprint ? (
        <span className="shrink-0 font-mono text-[11px] text-faint" aria-label={`Fingerprint ${device.fingerprint}`}>
          {device.fingerprint}
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-faint">No fingerprint yet</span>
      )}
      {device.connection && (
        <Button variant="ghost" size="xs" className="shrink-0" aria-label={`Disconnect ${device.label}`} disabled={busy} onClick={() => void disconnectDevice(device.id)}>
          Disconnect
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-destructive hover:text-destructive"
        aria-label={`Revoke ${device.label}`}
        disabled={busy}
        onClick={() => void revokePairing(device.id)}
      >
        Revoke
      </Button>
    </li>
  );
}

/** "Paired devices": the rows, or a line saying there are none. */
export function PairedDeviceList({ className }: { className?: string }) {
  const pairing = usePairing();
  const devices = pairedDevices(pairing.status.devices);
  return (
    <section aria-labelledby="paired-devices-label" className={className}>
      <h3 id="paired-devices-label" className="px-4 pt-3 pb-1 text-[11px] font-normal uppercase tracking-[.08em] text-faint">
        Paired devices
      </h3>
      {devices.length === 0 ? (
        <p className="px-4 pb-4 pt-1 text-xs text-faint">No paired devices</p>
      ) : (
        <ul>
          {devices.map((device) => (
            <PairedDeviceRow key={device.id} device={device} busy={pairing.busy} />
          ))}
        </ul>
      )}
    </section>
  );
}
