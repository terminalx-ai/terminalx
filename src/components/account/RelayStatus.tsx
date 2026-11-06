import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { retryRelay, usePairing } from "@/lib/pairing";

/** An interactive explanation, reachable by hover, click, or keyboard. */
export function RelayStatus() {
  const { status: { relay }, ready, relayRetrying, relayRetryError } = usePairing();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(timer.current);
  const closeSoon = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (trigger.current === document.activeElement || content.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, 200);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const label = !ready ? "Relay loading" : relay.phase === "connected" ? "Relay connected"
    : relay.phase === "connecting" ? "Relay connecting" : relay.phase === "offline" ? "Relay unavailable" : "Relay not configured";
  const explanation = !ready ? "Checking the Relay connection…" : relay.phase === "connected"
    ? "Relay lets paired phones and shared sessions reach this Mac from other networks. Local terminals keep running if Relay disconnects."
    : relay.phase === "off"
      ? "Relay is not configured for this session. Check Settings → Account. Local terminals and LAN pairing are available without Relay."
      : relay.message ?? "Relay is reconnecting automatically. Local terminals and LAN pairing remain available.";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className="absolute right-2 bottom-1.5 left-10 flex min-w-0 items-center gap-1 rounded-sm text-left text-[10px] font-normal text-faint hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          onPointerEnter={() => { cancelClose(); setOpen(true); }}
          onPointerLeave={closeSoon}
          onFocus={() => { cancelClose(); setOpen(true); }}
          onBlur={closeSoon}
          onClick={(event) => { event.preventDefault(); setOpen(true); }}
        >
          <span className={`size-1.5 shrink-0 rounded-full ${relay.phase === "connected" ? "bg-add" : "bg-faint"}`} />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          aria-label="Relay connection"
          side="top"
          align="start"
          sideOffset={8}
          className="z-(--z-tooltip) w-72 max-w-[calc(100vw-16px)] rounded-md bg-popover glass p-3 text-xs text-popover-foreground shadow-surface hairline"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={cancelClose}
          onPointerLeave={closeSoon}
          onFocus={cancelClose}
          onBlur={closeSoon}
        >
          <p className="font-medium">{label}</p>
          <p className="mt-1 leading-relaxed text-muted-foreground">{explanation}</p>
          {relay.phase === "connecting" && <p className="mt-2 text-muted-foreground">Connecting securely…{relay.attempt > 1 ? ` Attempt ${relay.attempt}.` : ""}</p>}
          {relayRetryError && <p role="alert" className="mt-2 text-destructive">{relayRetryError}</p>}
          {(relay.phase === "offline" || relay.phase === "connecting") && (
            <Button className="mt-3" size="xs" variant="outline" disabled={relayRetrying || relay.phase === "connecting"} onClick={() => void retryRelay()}>
              {relayRetrying || relay.phase === "connecting" ? "Retrying…" : "Retry"}
            </Button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
