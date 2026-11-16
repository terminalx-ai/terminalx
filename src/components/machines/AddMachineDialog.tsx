import { useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, Check, LoaderCircle, Monitor, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { minutesSeconds } from "@/components/pairing/pairingText";
import { cn } from "@/lib/cn";
import { MACHINE_CODE_PREFIX, type MachineRoute, type PairedMachine } from "@/types/machines";
import { AccountTab } from "./AccountTab";
import { HeadlessServerTab } from "./HeadlessServerTab";
import { FingerprintBox, PlatformIcon, machineSummary, sectionLabel, soft } from "./machineText";
import { failureCopy, useMachinePairing, type MachinePairing } from "./useMachinePairing";

export { failureCopy };

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

/** Screens 21.03 (On your account), 21.04 (Pairing code) and 21.06 (Headless server). */
export function AddMachineDialog({ open, onOpenChange, onPaired }: { open: boolean; onOpenChange: (open: boolean) => void; onPaired?: (machine: PairedMachine) => void }) {
  if (!open) return null;
  return <AddMachine onClose={() => onOpenChange(false)} onPaired={onPaired} />;
}

type AddTab = "account" | "pairingCode" | "headless";
const TABS: { value: AddTab; label: string }[] = [
  { value: "account", label: "On your account" },
  { value: "pairingCode", label: "Pairing code" },
  { value: "headless", label: "Headless server" },
];

function AddMachine({ onClose, onPaired }: { onClose: () => void; onPaired?: (machine: PairedMachine) => void }) {
  const [tab, setTab] = useState<AddTab>("account");
  // Each tab keeps its own code; leaving a tab cancels a pairing it is waiting on.
  const byAccount = useMachinePairing({ askOnRead: true, onPaired });
  const byCode = useMachinePairing({ askOnRead: true, onPaired });
  const headless = useMachinePairing({ askOnRead: false, onPaired });
  const tabRefs = useRef<Record<AddTab, HTMLButtonElement | null>>({ account: null, pairingCode: null, headless: null });
  const pairingOf = (which: AddTab) => (which === "account" ? byAccount : which === "pairingCode" ? byCode : headless);

  const choose = (next: AddTab) => {
    if (next === tab) return;
    pairingOf(tab).cancel();
    setTab(next);
  };
  const onTabKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const at = TABS.findIndex((t) => t.value === tab);
    const next = TABS[(at + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].value;
    choose(next);
    tabRefs.current[next]?.focus();
  };

  const close = () => {
    byAccount.cancel();
    byCode.cancel();
    headless.cancel();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent width={tab === "headless" ? "max-w-[820px]" : tab === "account" ? "max-w-[640px]" : "max-w-[720px]"} showClose={false} className="gap-0 p-0" data-testid="add-machine">
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
        <div className="px-5 pt-4">
          <div role="tablist" aria-label="How to add the machine" className="inline-flex max-w-full rounded-md border border-hairline bg-raised p-0.5" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.value}
                ref={(el) => {
                  tabRefs.current[t.value] = el;
                }}
                type="button"
                role="tab"
                id={`add-machine-tab-${t.value}`}
                aria-selected={tab === t.value}
                aria-controls={`add-machine-panel-${t.value}`}
                tabIndex={tab === t.value ? 0 : -1}
                onClick={() => choose(t.value)}
                className={cn(
                  "flex h-7 items-center whitespace-nowrap rounded-[5px] px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  tab === t.value ? "bg-selected text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div role="tabpanel" id={`add-machine-panel-${tab}`}>
          {tab === "account" ? (
            <AccountTab pairing={byAccount} onClose={close} onDone={onClose} onUseCode={() => choose("pairingCode")} />
          ) : tab === "pairingCode" ? (
            <PairingCodeTab pairing={byCode} onClose={close} onDone={onClose} />
          ) : (
            <HeadlessServerTab pairing={headless} onClose={close} onDone={onClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Screen 21.04: paste a code, compare the fingerprint, wait for Allow. */
function PairingCodeTab({ pairing, onClose, onDone }: { pairing: MachinePairing; onClose: () => void; onDone: () => void }) {
  const { code, step, inspected, remaining, route, setRoute, routeError, changeCode, ask } = pairing;
  const name = inspected?.machine.name ?? "the machine";
  const waiting = step.kind === "waiting";
  const failure = step.kind === "failed" ? failureCopy(step.reason, name) : null;
  // A code that was refused for good is spent: paste a new one. One that may work again stays.
  const codeLocked = waiting || step.kind === "inspecting" || step.kind === "paired";
  // The field grows to show the whole code: a pasted one wraps past the three rows it starts with.
  const codeField = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const field = codeField.current;
      if (!field) return;
      field.style.height = "auto";
      if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [code]);

  return (
    <>
        <div className="grid grid-cols-[minmax(0,1fr)_260px] max-[699px]:grid-cols-1">
          <div className="grid min-w-0 content-start gap-3 p-5">
            <div className="grid gap-1">
              <label htmlFor="machine-code" className="text-[13px] font-medium">Pairing code</label>
              <p className={soft}>On the other computer, open Settings → Machines and choose Create pairing code.</p>
            </div>
            <textarea
              ref={codeField}
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
                "w-full resize-none overflow-hidden break-all rounded-lg border bg-well px-3 py-2 font-mono text-[12.5px] leading-[19px] outline-none placeholder:text-faint",
                // Read-only while it waits: a plain hairline, and no focus ring on a field that takes no typing.
                codeLocked ? "border-hairline text-muted-foreground" : "border-hairline-strong focus-visible:ring-2 focus-visible:ring-ring",
              )}
            />
            {step.kind === "invalid" && (
              <div role="alert" className="grid gap-0.5 text-[12.5px]">
                <span className="font-medium text-destructive">This is not a machine pairing code</span>
                <span className="text-muted-foreground">{step.detail ?? `A machine’s code starts with ${MACHINE_CODE_PREFIX} Copy it again from Settings → Machines on the other computer.`}</span>
              </div>
            )}
            {step.kind === "inspecting" && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading the code…</div>
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
                    <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden /> Waiting for approval on {name}…
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
            <Button size="sm" onClick={onDone}>Done</Button>
          ) : (
            <>
              {inspected && (failure?.retry || step.kind === "fault") && remaining > 0 && (
                <Button variant="outline" size="sm" onClick={ask}>Try again</Button>
              )}
              <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            </>
          )}
        </footer>
    </>
  );
}
