import { useEffect } from "react";
import { Check, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { approveMachine, bootMachineHost, clearMachineHostError, declineMachine, refreshMachineHost, setMachinesKeepAwake, useMachineHost } from "@/lib/machines";
import { MachineHostError } from "./MachineHostError";
import type { PendingComputer } from "@/types/machines";
import { FingerprintBox, PlatformIcon, sectionLabel } from "./machineText";

const ABLE = [
  "Start, steer and stop sessions in this Mac’s projects",
  "Open terminals and read or change files in those projects",
  "Commit, push and open pull requests with this Mac’s git sign-in",
];

// Owner decision 2 (2026-11-15): what TerminalX offers it, and a plain line on what a shell can reach.
const NOT_OFFERED = [
  "Use this Mac’s built-in browser, computer use or dictation",
  "Pair other computers or change who may operate this Mac",
];

/** Screen 21.05, app-wide: it opens by itself while a computer waits for Allow, and goes when the request ends. */
export function MachineApprovalHost() {
  const host = useMachineHost();
  useEffect(() => {
    void bootMachineHost();
  }, []);
  const pending = host.view?.status?.pending ?? null;
  if (!pending) return null;
  // A new request is a new dialog: nothing from the last one carries over.
  return <MachineApprovalDialog key={pending.requestId} request={pending} />;
}

export function MachineApprovalDialog({ request }: { request: PendingComputer }) {
  const host = useMachineHost();
  const keepAwake = host.view?.keepAwake ?? true;
  const decline = () => void declineMachine(request.requestId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing it is an answer: the computer was not allowed.
        if (!open) decline();
      }}
    >
      <DialogContent width="max-w-[560px]" showClose={false} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0" data-testid="machine-approval">
        <header className="flex items-start gap-3 px-6 pb-4 pt-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-well">
            <PlatformIcon platform={request.platform} className="size-[18px] text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[15px] font-semibold leading-6">Let {request.label} operate this Mac?</DialogTitle>
            <DialogDescription className="text-[12.5px] text-muted-foreground">
              It asked to pair a moment ago, {request.transport === "relay" ? "through TerminalX Relay" : "over this network"}.
            </DialogDescription>
          </div>
        </header>
        <div className="grid gap-4 px-6 pb-5">
          <FingerprintBox fingerprint={request.fingerprint} caption={`Allow only if ${request.label} shows the same one`} />
          <section className="grid gap-2" aria-label="It will be able to">
            <div className={sectionLabel}>It will be able to</div>
            <ul className="grid gap-1.5 text-[13px]">
              {ABLE.map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-add" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid gap-2" aria-label="TerminalX won't let it">
            <div className={sectionLabel}>TerminalX won’t let it</div>
            <ul className="grid gap-1.5 text-[13px]">
              {NOT_OFFERED.map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <X className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] leading-[19px] text-muted-foreground">Its terminals and agents run as you, so they can reach anything your account can.</p>
          </section>
          <label className="flex items-center gap-3 border-t border-hairline pt-4">
            <span className="text-[13px]">Keep this Mac awake while it is connected</span>
            <Switch
              className="ml-auto"
              aria-label="Keep this Mac awake while it is connected"
              checked={keepAwake}
              onCheckedChange={(enabled) => void setMachinesKeepAwake(enabled)}
            />
          </label>
          {host.error && (
            <MachineHostError
              error={host.error}
              onRestarted={() => {
                clearMachineHostError();
                void refreshMachineHost();
              }}
            />
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-6 py-3.5">
          <span className="mr-auto text-[12.5px] text-muted-foreground">You can revoke it later in Settings → Machines.</span>
          <Button variant="outline" size="sm" disabled={host.busy} onClick={decline}>
            Don’t allow
          </Button>
          <Button variant="accent" size="sm" disabled={host.busy} onClick={() => void approveMachine(request.requestId)}>
            Allow
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
