import { Smartphone } from "@/icons";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { disconnectDevice, usePairing } from "@/lib/pairing";
import { pairedDevices } from "./PairedDevices";

/**
 * While a phone has a live connection, a pill at the top centre of the window
 * says so: it can see and drive every session here. Disconnect ends the
 * connections and keeps the pairing.
 */
export function ConnectedBar() {
  const pairing = usePairing();
  const privacy = useDataPrivacy();
  const connected = pairedDevices(pairing.status.devices).filter((device) => device.connection);
  if (connected.length === 0) return null;
  const one = connected.length === 1;
  const who = one ? (privacy.enabled ? "A phone" : connected[0].label) : `${connected.length} phones`;
  const disconnect = async () => {
    for (const device of connected) await disconnectDevice(device.id);
  };
  return (
    <div
      role="status"
      data-testid="phone-connected-bar"
      className="fixed top-1.5 left-1/2 z-(--z-toast) flex h-7 max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-add/30 bg-[color-mix(in_srgb,var(--accent-add)_14%,var(--popover))] px-3 text-xs text-add shadow-surface"
    >
      <Smartphone className="size-[13px] shrink-0" aria-hidden />
      <span className="truncate">
        {who} {one ? "is" : "are"} connected · {one ? "it" : "they"} can see and drive your sessions
      </span>
      <button
        type="button"
        disabled={pairing.busy}
        onClick={() => void disconnect()}
        className="shrink-0 rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
      >
        Disconnect
      </button>
    </div>
  );
}
