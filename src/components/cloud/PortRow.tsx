import type { ReactNode } from "react";
import { Check, Copy, Loader2, Square, SquareArrowOutUpRight } from "@/icons";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { forwardAddress } from "@/lib/portForwards";
import type { CloudPortForward } from "@/lib/api";

/**
 * One port, as 14.10 and 14.11 draw it: a dot for where it stands, the port,
 * the program listening, then its forward's address with Open, Copy and Stop,
 * or why it has none with Forward or Start again.
 *
 * - `open`: listening on this Mac now.
 * - `waiting`: kept while the connection is away or Forwarding is off; it opens again by itself.
 * - `expired`: was open here and closed without a Stop here; its address no longer works.
 * - `listening`: listens there and is not forwarded.
 */
export type PortRowState =
  | { kind: "open"; forward: CloudPortForward; gone: boolean }
  | { kind: "waiting"; forward: CloudPortForward; why: string }
  | { kind: "expired"; localPort: number }
  | { kind: "listening" };

export interface PortRowModel {
  port: number;
  /** `vite · console`; null when the runtime did not name the program. */
  label: string | null;
  state: PortRowState;
}

/** The icon buttons of a forwarded row (14.10: open, copy, stop). */
function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <WithTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-veil-strong hover:text-foreground disabled:opacity-50 [&_svg]:size-[13px]"
      >
        {children}
      </button>
    </WithTooltip>
  );
}

/** The outlined text button of an unforwarded or expired row: Forward, Start again. */
function TextAction({ children, onClick, disabled, busy }: { children: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-hairline-strong px-3 text-[12.5px] text-muted-foreground hover:bg-veil-raised hover:text-foreground disabled:opacity-50"
    >
      {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function PortRow({
  row,
  failure,
  where,
  busy,
  locked,
  copied,
  onOpen,
  onCopy,
  onStop,
  onForward,
}: {
  row: PortRowModel;
  failure?: string;
  /** "on Mac mini", "in the workspace": where the port listens. */
  where: string;
  /** A change to this port is under way. */
  busy: boolean;
  /** Another change is under way, or nothing can be changed now: Forward and Start again wait. */
  locked: boolean;
  copied: boolean;
  onOpen: (localPort: number) => void;
  onCopy: (localPort: number) => void;
  onStop: (port: number) => void;
  onForward: (port: number) => void;
}) {
  const { port, label, state } = row;
  const dot = failure ? "bg-destructive" : state.kind === "open" ? "bg-add" : state.kind === "listening" ? "bg-faint" : "bg-warning";
  return (
    <div className="px-3 py-1.5" data-testid="cloud-port" data-port={port} data-state={state.kind}>
      <div className="flex h-8 items-center gap-2.5 text-[12.5px]">
        <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
        <span className="w-11 shrink-0 font-mono text-foreground">{port}</span>
        <span className="w-[118px] shrink-0 truncate text-muted-foreground" title={label ?? undefined} data-testid="cloud-port-process">
          {label ?? ""}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {state.kind === "open" && (
            <>
              <span className="font-mono text-add" data-testid="cloud-port-address">
                → {forwardAddress(state.forward.localPort)}
              </span>
              {state.gone && <span className="ml-1.5 text-muted-foreground">nothing listens {where} now</span>}
            </>
          )}
          {state.kind === "waiting" && (
            <span data-testid="cloud-port-waiting">
              <span className="font-mono text-faint">{forwardAddress(state.forward.localPort)}</span> <span className="text-warning">{state.why}</span>
            </span>
          )}
          {state.kind === "expired" && (
            <span data-testid="cloud-port-expired">
              <span className="font-mono text-faint line-through">{forwardAddress(state.localPort)}</span> <span className="text-warning">closed when the connection dropped</span>
            </span>
          )}
          {failure && <span className="text-destructive">couldn’t forward</span>}
          {state.kind === "listening" && !failure && <span className="text-faint">not forwarded</span>}
        </span>
        {state.kind === "open" && (
          <span className="flex shrink-0 items-center gap-1">
            <IconAction label="Open in the built-in browser" onClick={() => onOpen(state.forward.localPort)}>
              <SquareArrowOutUpRight />
            </IconAction>
            <IconAction label={copied ? "Copied" : `Copy http://${forwardAddress(state.forward.localPort)}`} onClick={() => onCopy(state.forward.localPort)}>
              {copied ? <Check /> : <Copy />}
            </IconAction>
            <IconAction label={`Stop forwarding ${port}`} disabled={busy} onClick={() => onStop(port)}>
              <Square className="size-[11px]!" />
            </IconAction>
          </span>
        )}
        {state.kind === "waiting" && (
          <span className="flex shrink-0 items-center gap-1">
            <IconAction label={`Stop forwarding ${port}`} disabled={busy} onClick={() => onStop(port)}>
              <Square className="size-[11px]!" />
            </IconAction>
          </span>
        )}
        {failure ? (
          <TextAction busy={busy} disabled={locked} onClick={() => onForward(port)}>
            Retry
          </TextAction>
        ) : state.kind === "expired" ? (
          <TextAction busy={busy} disabled={locked} onClick={() => onForward(port)}>
            Start again
          </TextAction>
        ) : state.kind === "listening" && (
          <TextAction busy={busy} disabled={locked} onClick={() => onForward(port)}>
            Forward
          </TextAction>
        )}
      </div>
      {failure && <p className="ml-4 border-l border-destructive/30 pl-2 text-xs text-destructive" role="alert">{failure}</p>}
    </div>
  );
}

/** A section's small capitals: FORWARDED, NOT FORWARDED, PORTS DETECTED. */
export function PortSection({ children, trailing }: { children: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center px-3.5 pt-3 pb-0.5 text-xs uppercase tracking-[.08em] text-faint">
      {children}
      {trailing && <span className="ml-auto flex items-center gap-1 normal-case tracking-normal text-muted-foreground">{trailing}</span>}
    </div>
  );
}
