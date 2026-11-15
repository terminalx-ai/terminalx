import { useRef, useState } from "react";
import { CheckCircle2, Check, Loader2, Monitor, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { minutesSeconds, useSecondsLeft } from "@/components/pairing/pairingText";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { machinesApi } from "@/lib/machines";
import { MACHINE_CODE_PREFIX, type InspectedMachineCode, type MachinePairingFailure, type MachineRoute, type PairedMachine } from "@/types/machines";
import { FingerprintBox, PlatformIcon, machineSummary, sectionLabel, soft } from "./machineText";

const ROUTE_OPTIONS = [
  { value: "relayAndNearby" as const, label: "Relay and nearby" },
  { value: "thisNetwork" as const, label: "Only this network" },
];

/** Owner decision 4 (2026-11-15): nearby routes first; the relay once both are signed in to the same account. */
export function routeHint(route: MachineRoute, name: string): string {
  return route === "relayAndNearby"
    ? `Tries ${name} directly on this network or Tailscale first. TerminalX Relay is used once this Mac and ${name} are signed in to the same account. Every path is end-to-end encrypted.`
    : `Reaches ${name} only on this network or through Tailscale. The connection is end-to-end encrypted.`;
}

/** What went wrong, and whether the same code may be tried again. */
export function failureCopy(reason: MachinePairingFailure, name: string): { title: string; detail: string; retry: boolean } {
  switch (reason) {
    case "not-approved":
      return { title: `${name} did not allow this Mac`, detail: `Don’t allow was chosen there, or no one answered within two minutes. Create a new code on ${name} to try again.`, retry: false };
    case "code-inactive":
      return { title: "This code no longer works", detail: `It expired, was used, or a newer code replaced it. Create a new code on ${name} and paste it here.`, retry: false };
    case "another-computer":
      return { title: `Another computer is waiting on ${name}`, detail: "Only one computer can ask at a time. Try again once it has been answered.", retry: true };
    case "pairing-paused":
      return { title: `Pairing is paused on ${name}`, detail: "Too many wrong codes were tried there. Try again in a minute.", retry: true };
    case "unreachable":
      return { title: `This Mac could not reach ${name}`, detail: `Check that ${name} is awake and on this network or Tailscale, then try again.`, retry: true };
    case "invalid-code":
      return { title: "This is not a machine pairing code", detail: "Copy it again from Settings → Machines on the other computer.", retry: false };
    case "cancelled":
      return { title: "Pairing was cancelled", detail: "Paste the code again to pair.", retry: true };
  }
}

type Step =
  | { kind: "empty" }
  | { kind: "inspecting" }
  | { kind: "invalid"; detail: string | null }
  | { kind: "waiting"; inspected: InspectedMachineCode }
  | { kind: "paired"; inspected: InspectedMachineCode; machine: PairedMachine }
  | { kind: "failed"; inspected: InspectedMachineCode; reason: MachinePairingFailure }
  | { kind: "fault"; inspected: InspectedMachineCode; message: string };

/** Screen 21.04 with the pairing code only (owner decision 4): paste a code, compare the fingerprint, wait for Allow. */
export function AddMachineDialog({ open, onOpenChange, onPaired }: { open: boolean; onOpenChange: (open: boolean) => void; onPaired?: (machine: PairedMachine) => void }) {
  if (!open) return null;
  return <AddMachine onClose={() => onOpenChange(false)} onPaired={onPaired} />;
}

function AddMachine({ onClose, onPaired }: { onClose: () => void; onPaired?: (machine: PairedMachine) => void }) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "empty" });
  const [route, setRoute] = useState<MachineRoute>("relayAndNearby");
  const [routeError, setRouteError] = useState<string | null>(null);
  // The route chosen when Allow arrives wins, so it stays live while waiting.
  const routeNow = useRef(route);
  routeNow.current = route;
  // Each paste or attempt outdates the ones before: a late answer to an old one is dropped.
  const attempt = useRef(0);

  const inspected = "inspected" in step ? step.inspected : null;
  const name = inspected?.machine.name ?? "the machine";
  const remaining = useSecondsLeft(inspected?.expiresAt ?? null);

  const pair = async (text: string, found: InspectedMachineCode) => {
    const mine = ++attempt.current;
    setStep({ kind: "waiting", inspected: found });
    try {
      const result = await machinesApi.pair(text, routeNow.current);
      if (attempt.current !== mine) return;
      if (!result.paired) {
        if (result.reason === "cancelled") return;
        setStep({ kind: "failed", inspected: found, reason: result.reason });
        return;
      }
      let machine = result.machine;
      if (machine.route !== routeNow.current) {
        try {
          await machinesApi.setRoute(machine.machineId, routeNow.current);
          machine = { ...machine, route: routeNow.current };
        } catch (error) {
          setRouteError(errorMessage(error));
        }
      }
      if (attempt.current !== mine) return;
      setStep({ kind: "paired", inspected: found, machine });
      onPaired?.(machine);
    } catch (error) {
      if (attempt.current === mine) setStep({ kind: "fault", inspected: found, message: errorMessage(error) });
    }
  };

  const changeCode = async (value: string) => {
    setCode(value);
    setRouteError(null);
    const text = value.trim();
    const mine = ++attempt.current;
    if (!text) return setStep({ kind: "empty" });
    if (!text.startsWith(MACHINE_CODE_PREFIX)) return setStep({ kind: "invalid", detail: null });
    setStep({ kind: "inspecting" });
    try {
      const found = await machinesApi.inspectCode(text);
      if (attempt.current !== mine) return;
      // The code names the machine and the fingerprint: ask at once, the person compares while it waits.
      void pair(text, found);
    } catch (error) {
      if (attempt.current === mine) setStep({ kind: "invalid", detail: errorMessage(error) });
    }
  };

  const close = () => {
    if (step.kind === "waiting") {
      attempt.current++;
      void machinesApi.cancelPairing().catch(() => undefined);
    }
    onClose();
  };

  const waiting = step.kind === "waiting";
  const failure = step.kind === "failed" ? failureCopy(step.reason, name) : null;
  // A code that was refused for good is spent: paste a new one. One that may work again stays.
  const codeLocked = waiting || step.kind === "inspecting" || step.kind === "paired";

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent width="max-w-[700px]" showClose={false} className="gap-0 p-0" data-testid="add-machine">
        <header className="flex h-14 items-center gap-2.5 border-b border-hairline px-5">
          <Monitor className="size-[17px] shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 leading-4">
            <DialogTitle className="text-sm font-semibold">Add a machine</DialogTitle>
            <DialogDescription className="truncate text-[12px] text-faint">Operate another computer that runs TerminalX</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Close" className="ml-auto text-faint">
              <X />
            </Button>
          </DialogClose>
        </header>
        <div className="grid grid-cols-[minmax(0,1fr)_236px] max-[699px]:grid-cols-1">
          <div className="grid min-w-0 content-start gap-3 p-5">
            <div className="grid gap-1">
              <label htmlFor="machine-code" className="text-[13px] font-medium">Pairing code</label>
              <p className={soft}>On the other computer, open Settings → Machines and choose Create pairing code.</p>
            </div>
            <textarea
              id="machine-code"
              value={code}
              readOnly={codeLocked}
              spellCheck={false}
              autoComplete="off"
              rows={3}
              placeholder="txm2.…"
              aria-invalid={step.kind === "invalid" || (step.kind === "failed" && step.reason === "invalid-code") ? true : undefined}
              onChange={(event) => void changeCode(event.target.value)}
              className={cn(
                "w-full resize-none break-all rounded-lg border border-hairline-strong bg-well px-3 py-2 font-mono text-[12.5px] leading-[19px] outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring",
                codeLocked && "text-muted-foreground",
              )}
            />
            {step.kind === "invalid" && (
              <div role="alert" className="grid gap-0.5 text-[12.5px]">
                <span className="font-medium text-destructive">This is not a machine pairing code</span>
                <span className="text-muted-foreground">{step.detail ?? `A machine’s code starts with ${MACHINE_CODE_PREFIX} Copy it again from Settings → Machines on the other computer.`}</span>
              </div>
            )}
            {step.kind === "inspecting" && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading the code…</div>
            )}
            {inspected && (
              <div className="flex items-center gap-3 rounded-lg border border-hairline px-3 py-2.5" data-testid="machine-card">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-well">
                  <PlatformIcon platform={inspected.machine.os.family} className="size-4 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1 leading-5">
                  <div className="truncate text-[13px] font-medium">{inspected.machine.name}</div>
                  <div className="truncate text-[12px] text-muted-foreground">{machineSummary(inspected.machine.os, inspected.machine.version)}</div>
                </div>
                <Check className="size-4 shrink-0 text-add" aria-label="Code read" />
              </div>
            )}
            {inspected?.alreadyPaired && step.kind !== "paired" && (
              <p className={soft}>This Mac is already paired with {name}. Pairing again replaces its credential.</p>
            )}
            <div className={cn(sectionLabel, "mt-1")}>How this Mac reaches it</div>
            <Segmented aria-label="How this Mac reaches it" value={route} onChange={setRoute} options={ROUTE_OPTIONS} className="justify-self-start" disabled={step.kind === "paired"} />
            <p className={soft}>{routeHint(route, inspected ? name : "the machine")}</p>
            {routeError && <p role="alert" className="text-[12.5px] text-destructive">Paired, but the route was not saved: {routeError}</p>}
          </div>
          <div className="grid min-w-0 content-start gap-3 border-l border-hairline p-5 max-[699px]:border-l-0 max-[699px]:border-t">
            {!inspected ? (
              <div className="grid min-h-[132px] place-items-center rounded-xl border border-dashed border-hairline-strong p-4 text-center text-[12.5px] text-muted-foreground">
                The fingerprint shows here once a code is pasted.
              </div>
            ) : (
              <>
                <FingerprintBox fingerprint={inspected.fingerprint} caption={`${name} shows the same one`} />
                {step.kind === "paired" ? (
                  <div className="grid gap-1" role="status">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-add"><CheckCircle2 className="size-4 shrink-0" aria-hidden /> Paired with {name}</div>
                    <p className={soft}>It is in Your machines in Settings → Machines.</p>
                  </div>
                ) : (
                  <ol className={cn(soft, "grid list-decimal gap-1 pl-4 text-foreground")}>
                    <li>Compare this fingerprint with the one on {name}.</li>
                    <li>Choose Allow there.</li>
                  </ol>
                )}
                {waiting && (
                  <div className="flex items-center gap-2 text-[12.5px] text-info" role="status">
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> Waiting for approval on {name}…
                  </div>
                )}
                {failure && (
                  <div role="alert" className="grid gap-0.5 text-[12.5px]">
                    <span className="font-medium text-destructive">{failure.title}</span>
                    <span className="text-muted-foreground">{failure.detail}</span>
                  </div>
                )}
                {step.kind === "fault" && (
                  <div role="alert" className="grid gap-0.5 text-[12.5px]">
                    <span className="font-medium text-destructive">Pairing stopped</span>
                    <span className="break-words text-muted-foreground">{step.message}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <footer className="flex min-h-14 flex-wrap items-center gap-2 border-t border-hairline px-5 py-2.5">
          <span className="mr-auto text-[12.5px] text-muted-foreground" aria-live="polite">
            {step.kind === "paired"
              ? "The code was used and works no more."
              : inspected && remaining > 0
                ? `The code expires in ${minutesSeconds(remaining)} and works once.`
                : inspected
                  ? "The code has expired."
                  : "A code works once and lasts five minutes."}
          </span>
          {step.kind === "paired" ? (
            <Button size="sm" onClick={onClose}>Done</Button>
          ) : (
            <>
              {inspected && (failure?.retry || step.kind === "fault") && remaining > 0 && (
                <Button variant="outline" size="sm" onClick={() => void pair(code.trim(), inspected)}>Try again</Button>
              )}
              <Button variant="outline" size="sm" onClick={close}>Cancel</Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
