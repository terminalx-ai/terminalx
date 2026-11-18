import { Monitor, Server } from "@/icons";
import { cn } from "@/lib/cn";
import type { MachineOs } from "@/types/machines";

export const sectionLabel = "text-[12px] font-medium uppercase tracking-[.08em] text-faint";
export const soft = "text-[12.5px] leading-[19px] text-muted-foreground";

/** "CEF4·2468·FE26·9E4B" as two lines of two groups (owner decision 1, 2026-11-15). */
export function fingerprintLines(fingerprint: string): string[] {
  const groups = fingerprint.split("·");
  if (groups.length < 4) return [fingerprint];
  const half = Math.ceil(groups.length / 2);
  return [groups.slice(0, half).join("·"), groups.slice(half).join("·")];
}

/** The FINGERPRINT box both dialogs show: mono, two lines, and what to compare it with. */
export function FingerprintBox({ fingerprint, caption, className }: { fingerprint: string; caption: string; className?: string }) {
  return (
    <div className={cn("grid justify-items-center gap-1.5 rounded-xl border border-hairline bg-well px-4 py-3.5 text-center", className)} data-testid="machine-fingerprint">
      <div className={sectionLabel}>Fingerprint</div>
      <div className="grid font-mono text-[22px] leading-8 tracking-[.06em]" aria-label={`Fingerprint ${fingerprint}`}>
        {fingerprintLines(fingerprint).map((line) => (
          <span key={line} aria-hidden>{line}</span>
        ))}
      </div>
      <div className="text-[12.5px] text-muted-foreground">{caption}</div>
    </div>
  );
}

const OS_NAMES: Record<string, string> = { macos: "macOS", linux: "Linux" };

/** "macOS 26.1". */
export function osLabel(os: MachineOs): string {
  const name = OS_NAMES[os.family] ?? os.family;
  return os.version ? `${name} ${os.version}` : name;
}

/** "macOS 26.1 · TerminalX 0.2.33". */
export function machineSummary(os: MachineOs, version: string): string {
  return `${osLabel(os)} · TerminalX ${version}`;
}

/**
 * A server for Linux, a monitor for a Mac: the one icon a computer has in
 * Settings, the dialogs, the sidebar and the machine's view (21.01, 21.02).
 */
export function PlatformIcon({ platform, className }: { platform: string | null; className?: string }) {
  const linux = platform === "linux";
  const Icon = linux ? Server : Monitor;
  return <Icon className={className} aria-hidden data-icon={linux ? "server" : "monitor"} />;
}

/** "14:02": the 24-hour clock the screens use (21.02, 21.09), whatever the reader's locale. */
export function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** "Nov 3" in the reader's locale. */
export function shortDate(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(epochMs));
}

/**
 * The short key label on a machine's or computer's row ("7F3A·91C2"): the
 * first four bytes of SHA-256 of its public key, read from its id
 * (`host_id`, base64url of that hash). A label only: approving compares the
 * pairing fingerprint (docs/MACHINES.md decision 5). Null for an id that is
 * not one.
 */
export function keyLabel(id: string | null | undefined): string | null {
  if (!id || !/^[A-Za-z0-9_-]{6,}$/.test(id)) return null;
  const base64 = id.slice(0, 8).replace(/-/g, "+").replace(/_/g, "/");
  let bytes: string;
  try {
    bytes = atob(base64);
  } catch {
    return null;
  }
  const hex = Array.from(bytes.slice(0, 4), (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.length === 8 ? `${hex.slice(0, 4)}·${hex.slice(4)}` : null;
}

/** How a connection reaches the other computer, as the cards say it (21.02). */
export function routeLabel(kind: "lan" | "tailscale" | "relay"): string {
  return kind === "relay" ? "through Relay" : kind === "tailscale" ? "Direct over Tailscale" : "Direct on this network";
}

/** "today at 18:40", "yesterday at 18:40" or "Nov 3 at 18:40": the date in the reader's locale, the time on the 24-hour clock. */
export function seenText(epochMs: number, now = Date.now()): string {
  const time = clockTime(epochMs);
  const day = (ms: number) => {
    const date = new Date(ms);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(epochMs)) / 86_400_000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  return `${shortDate(epochMs)} at ${time}`;
}
