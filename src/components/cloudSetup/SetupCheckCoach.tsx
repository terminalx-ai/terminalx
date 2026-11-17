import { useRef, type ReactNode } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { useSetupCheckCoach } from "@/lib/setupCheckDraft";

/**
 * Where the coach points: across Send, but at the top edge of the composer
 * box, so the card sits wholly above the box and never covers the message it
 * asks the person to send (12.07).
 */
export function coachAnchorRect(send: DOMRect, box: DOMRect | null | undefined): DOMRect {
  return new DOMRect(send.x, box ? box.top : send.top, send.width, 0);
}

/**
 * The coach mark over Send in the setup check's composer (12.07): the
 * message waiting there is the check, and nothing is sent until the person
 * sends it. "Got it" or sending puts it away for good.
 */
export function SetupCheckCoach({ tabId, children }: { tabId: string; children: ReactNode }) {
  const coach = useSetupCheckCoach(tabId);
  const send = useRef<HTMLSpanElement>(null);
  const anchor = useRef({
    getBoundingClientRect: () => {
      const element = send.current;
      if (!element) return new DOMRect();
      return coachAnchorRect(element.getBoundingClientRect(), element.closest("[data-composer-box]")?.getBoundingClientRect());
    },
    get contextElement() {
      return send.current ?? undefined;
    },
  });
  if (!coach.show) return <>{children}</>;
  return (
    <PopoverPrimitive.Root open>
      <PopoverPrimitive.Anchor virtualRef={anchor} />
      <span ref={send} className="inline-flex" onClickCapture={coach.dismiss}>
        {children}
      </span>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="end"
          sideOffset={10}
          // The box grows as the message is edited; follow its top edge.
          updatePositionStrategy="always"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={coach.dismiss}
          onInteractOutside={(event) => event.preventDefault()}
          data-testid="setup-check-coach"
          className="z-(--z-menu) w-[270px] rounded-xl bg-raised p-3 text-foreground shadow-surface hairline outline-none"
        >
          <div className="text-[13px] font-semibold">Send this to check your new computer</div>
          <p className="mt-1.5 text-xs leading-[17px] text-muted-foreground">The agent installs what's missing and runs each repo's tests. Edit the message first if you like.</p>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-faint">1 of 1</span>
            <Button size="sm" onClick={coach.dismiss}>
              Got it
            </Button>
          </div>
          <PopoverPrimitive.Arrow className="fill-raised" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
