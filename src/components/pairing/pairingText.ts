import { useEffect, useState } from "react";
import type { MobileE2EETransport, PairedDevice } from "@/types/pairing";

/** Whole seconds left until `expiresAt` (epoch ms), ticking once a second; 0 once it has passed. */
export function useSecondsLeft(expiresAt: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (expiresAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt == null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

/** "4:52". */
export function minutesSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How a connection reached this Mac, as the device rows say it. */
export function pathLabel(transport: MobileE2EETransport): string {
  return transport === "relay" ? "through TerminalX Relay" : "over LAN";
}

/** "3 Nov, 18:20" in the reader's locale. */
function seenAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  return `${day}, ${time}`;
}

/** The second line of a paired device's row: live path, or when and how it was last seen. */
export function deviceStatus(device: PairedDevice): string {
  if (device.connection) return `Connected now · ${pathLabel(device.connection.transport)}`;
  if (!device.lastSeenAt) return "Not connected yet";
  const seen = `Last seen ${seenAt(device.lastSeenAt)}`;
  return device.lastSeenTransport ? `${seen} · ${pathLabel(device.lastSeenTransport)}` : seen;
}

/** The pairing code inside the QR's link, for typing on a phone that cannot scan. */
export function fallbackCode(pairingUrl: string): string {
  try {
    return new URL(pairingUrl).searchParams.get("code") ?? pairingUrl;
  } catch {
    return pairingUrl;
  }
}
