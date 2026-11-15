import { Laptop, Server } from "@/icons";
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

/** A laptop for a Mac, a server for anything else. */
export function PlatformIcon({ platform, className }: { platform: string | null; className?: string }) {
  const Icon = platform === "linux" ? Server : Laptop;
  return <Icon className={className} aria-hidden />;
}

/** "Nov 3" in the reader's locale. */
export function shortDate(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(epochMs));
}
