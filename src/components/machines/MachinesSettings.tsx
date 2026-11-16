import { useCallback, useEffect, useState } from "react";
import { Check, Copy, LoaderCircle, Plus } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { RegisteredSetting } from "@/components/settings/settingsRegistry";
import { minutesSeconds, useSecondsLeft } from "@/components/pairing/pairingText";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { bootMachineHost, createMachineCode, machinesApi, revokeComputer, setAllowOperating, useMachineHost } from "@/lib/machines";
import { refreshPairedMachines } from "@/lib/machineConnections";
import type { MachinePairingCode, PairedComputer, PairedMachine } from "@/types/machines";
import { AddMachineDialog } from "./AddMachineDialog";
import { PlatformIcon, machineSummary, osLabel, shortDate, soft } from "./machineText";

const heading = "text-[14px] font-semibold";
const list = "mt-3 overflow-hidden rounded-lg border border-hairline";
const row = "flex min-h-14 items-center gap-3 border-b border-hairline px-4 py-2 last:border-b-0";

/**
 * Settings → Machines, shown only with Experimental → Machines on (owner decision 3,
 * 2026-11-15). PRO-349 builds the full page later; this holds the controls.
 */
export function MachinesSettings() {
  const host = useMachineHost();
  useEffect(() => {
    void bootMachineHost();
  }, []);
  const view = host.view;
  const allow = view?.allowOperating ?? false;

  return (
    <div className="flex flex-col gap-6" data-testid="machines-settings">
      <p className="text-[13px] text-muted-foreground">Operate TerminalX on your other computers from this Mac. Sessions, terminals and files stay on the machine that runs them.</p>
      <div>
        <RegisteredSetting
          setting="machines.allowOperating"
          control={
            <Switch
              aria-label="Let other computers operate this Mac"
              checked={allow}
              disabled={!host.ready || host.busy || !view}
              onCheckedChange={(on) => void setAllowOperating(on)}
            />
          }
        />
        {host.error && <p role="alert" className="text-[12.5px] text-destructive">{host.error}</p>}
        {host.ready && view && !view.status && <p className="text-[12.5px] text-muted-foreground">The TerminalX runtime cannot be reached, so this Mac cannot be operated right now.</p>}
        {view?.status?.error && <p role="alert" className="text-[12.5px] text-destructive">{view.status.error}</p>}
      </div>
      <RegisteredSetting setting="machines.yours">
        <section>
          <YourMachines />
        </section>
      </RegisteredSetting>
      <RegisteredSetting setting="machines.computers">
        <section>
          <div className={heading}>Computers that can operate this Mac</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            Each has its own credential. Revoking one ends that credential and closes its connection. It does not undo what was already done through its terminals.
          </p>
          {/* A code is how a computer joins this list, so it is made here, under Your machines (21.02). */}
          {allow && (
            <RegisteredSetting setting="machines.pairingCode">
              <div className="mt-3">
                <PairingCode />
              </div>
            </RegisteredSetting>
          )}
          <ComputerList computers={view?.status?.computers ?? []} busy={host.busy} />
        </section>
      </RegisteredSetting>
    </div>
  );
}

/** The code another computer pastes in Add a machine. Only `createCode` returns it; the status knows its expiry. */
function PairingCode() {
  const status = useMachineHost().view?.status ?? null;
  const [made, setMade] = useState<MachinePairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pausedLeft = useSecondsLeft(status?.pausedUntil ?? null);
  // The status ends the code when it is used, replaced or runs out: show it only while it is the live one.
  const live = made && status?.code?.expiresAt === made.expiresAt ? made : null;
  const left = useSecondsLeft(live?.expiresAt ?? null);
  const otherLive = !live && status?.code ? status.code : null;
  const otherLeft = useSecondsLeft(otherLive?.expiresAt ?? null);
  const paused = pausedLeft > 0;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setMade(await createMachineCode());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!live) return;
    await navigator.clipboard.writeText(live.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-4">
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">
          To add a computer, create a pairing code and paste it in Add a machine there. Allow it here only if both screens show the same fingerprint.
        </p>
        <Button className="shrink-0" size="sm" variant="outline" disabled={busy || paused || !status} onClick={() => void create()}>
          {busy ? <LoaderCircle className="animate-spin" /> : null} {live ? "Create a new code" : "Create pairing code"}
        </Button>
      </div>
      {live && left > 0 && (
        <div className="grid gap-1.5" data-testid="machine-pairing-code">
          <code className="block break-all rounded-lg border border-hairline-strong bg-well px-3 py-2 font-mono text-[12.5px] leading-[19px]">{live.code}</code>
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <span aria-live="polite">Expires in {minutesSeconds(left)} · works once</span>
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void copy()}>
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy code"}
            </Button>
          </div>
        </div>
      )}
      {otherLive && otherLeft > 0 && (
        <p className={soft}>A code made earlier works for {minutesSeconds(otherLeft)} more. Creating a new code ends it.</p>
      )}
      {paused && (
        <p role="status" className="text-[12.5px] text-warning">Pairing is paused after too many wrong codes. Try again in {minutesSeconds(pausedLeft)}.</p>
      )}
      {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
    </div>
  );
}

/** Machines this Mac can operate, read from `machines.json`, and Add a machine. */
function YourMachines() {
  const [machines, setMachines] = useState<PairedMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      setMachines(await machinesApi.list());
      setError(null);
    } catch (e) {
      setMachines([]);
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <div className={heading}>Your machines</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">Computers this Mac can operate. Each one appears as a section in the sidebar.</p>
        </div>
        <Button className="shrink-0" onClick={() => setAdding(true)}>
          <Plus /> Add a machine
        </Button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12.5px] text-destructive">{error}</p>}
      {machines && machines.length > 0 && (
        <ul className={list} aria-label="Your machines">
          {machines.map((machine) => (
            <li key={machine.machineId} className={row} data-testid="paired-machine">
              <PlatformIcon platform={machine.os.family} className="size-[18px] shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 leading-5">
                <div className="truncate text-[13px]">{machine.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {machineSummary(machine.os, machine.version)} · {machine.route === "thisNetwork" ? "Only this network" : "Relay and nearby"} · paired {shortDate(machine.pairedAt)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {machines && machines.length === 0 && !error && <p className="mt-3 text-[12.5px] text-faint">No machines yet.</p>}
      <AddMachineDialog open={adding} onOpenChange={setAdding} onPaired={() => {
        void load();
        // The sidebar lists it, and attaches it while Machines is on.
        void refreshPairedMachines();
      }} />
    </>
  );
}

function ComputerList({ computers, busy }: { computers: PairedComputer[]; busy: boolean }) {
  if (computers.length === 0) return <p className="mt-3 text-[12.5px] text-faint">No computer can operate this Mac.</p>;
  return (
    <ul className={list} aria-label="Computers that can operate this Mac">
      {computers.map((computer) => (
        <ComputerRow key={computer.id} computer={computer} busy={busy} />
      ))}
    </ul>
  );
}

function computerLine(computer: PairedComputer): string {
  const platform = computer.platform ? osLabel({ family: computer.platform, version: null }) : null;
  const seen = computer.connected ? null : computer.lastSeenAt ? `last seen ${shortDate(computer.lastSeenAt)}` : "not connected yet";
  return [platform, seen, `approved ${shortDate(computer.approvedAt)}`].filter(Boolean).join(" · ");
}

/** One computer that may operate this Mac. Revoke asks once: it ends the credential and closes the connection. */
function ComputerRow({ computer, busy }: { computer: PairedComputer; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={cn(row, confirming && "flex-wrap")} data-testid="operating-computer">
      <PlatformIcon platform={computer.platform} className="size-[18px] shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 leading-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px]">{computer.label}</span>
          {computer.connected && <span className="shrink-0 text-[12px] text-add">Connected now</span>}
        </div>
        <div className="truncate text-[12px] text-muted-foreground">{computerLine(computer)}</div>
      </div>
      {confirming ? (
        <div className="flex w-full flex-wrap items-center gap-2 pb-1 pl-[30px]" role="group" aria-label={`Revoke ${computer.label}`}>
          <span className="mr-auto min-w-0 text-[12.5px] text-muted-foreground">
            Ends {computer.label}’s credential and closes its connection. It does not undo what it already did on this Mac.
          </span>
          <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Keep</Button>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void revokeComputer(computer.id).then(() => setConfirming(false))}>
            Revoke
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="shrink-0 text-[13px] text-destructive hover:text-destructive" disabled={busy} onClick={() => setConfirming(true)}>
          Revoke
        </Button>
      )}
    </li>
  );
}
