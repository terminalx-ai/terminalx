import { useCallback, useEffect, useRef, useState } from "react";
import { ThisComputer, thisComputer } from "@/lib/platform";
import { CheckCircle2, LoaderCircle, Lock, LogIn, Monitor, RotateCw, Server } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { signIn, useAccount } from "@/lib/account";
import { cn } from "@/lib/cn";
import { machinesApi } from "@/lib/machines";
import type { AccountMachine, MachineAccountDirectory } from "@/types/machines";
import { FingerprintBox, PlatformIcon, machineSummary, osLabel, seenText, soft } from "./machineText";
import { failureCopy, type MachinePairing } from "./useMachinePairing";

const ROUTE_OPTIONS = [
  { value: "relayAndNearby" as const, label: "Relay and nearby" },
  { value: "thisNetwork" as const, label: "Only this network" },
];

/** Why `machines_account_request` stopped, by the prefix the command refuses with. */
export function requestFailure(message: string, name: string): string {
  const code = message.split(":")[0];
  switch (code) {
    case "machine_offline":
      return `${name} is not online. Open TerminalX on it, or wait until it is back, then try again.`;
    case "machine_not_available":
      return `Remote operation is off on ${name}. Turn on letting other computers operate it there, in Settings → Machines.`;
    case "grant_refused":
      return `${name} did not give ${thisComputer} a pairing grant. Try again, or use a pairing code.`;
    case "grant_expired":
      return `${name} did not answer within five minutes. Check that TerminalX is open there, then try again.`;
    case "key_mismatch":
      return `${name}’s answer did not match the key the account lists for it, so ${thisComputer} did not use it. Pair with a code from ${name} instead.`;
    case "not_signed_in":
      return "Sign in to your TerminalX account to connect through it.";
    default:
      return message;
  }
}

function MachineGlyph({ machine }: { machine: AccountMachine }) {
  const Icon = machine.platform === "linux" ? Server : Monitor;
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted">
      <Icon className="size-[15px] text-muted-foreground" aria-hidden />
    </span>
  );
}

function rowLine(machine: AccountMachine): string {
  const system = [machine.platform ? osLabel({ family: machine.platform, version: null }) : null, machine.environmentKind === "ssh" ? "headless" : null].filter(Boolean).join(" · ");
  const where = machine.platform === "macos" ? "that Mac" : "that computer";
  if (machine.thisMac) return ThisComputer;
  if (machine.availability === "notAvailable") return `Remote operation is off on ${where}. Turn it on there in Settings → Machines.`;
  if (machine.availability === "offline") return machine.lastSeenAt ? `Offline · last seen ${seenText(machine.lastSeenAt)}` : "Offline";
  return [system, "online now"].filter(Boolean).join(" · ");
}

type Asking = { hostId: string; name: string; grantRequestId: string | null; error: string | null };

/**
 * Screen 21.03: the computers on this Mac's TerminalX account. Connect asks
 * that computer for a one-time grant; its sealed offer comes back as a code,
 * and from there it pairs as a pasted code does: the fingerprint here, Allow
 * there.
 */
export function AccountTab({ pairing, onClose, onDone, onUseCode }: { pairing: MachinePairing; onClose: () => void; onDone: () => void; onUseCode: () => void }) {
  // The directory says whether an account is signed in; a sign-in or sign-out here reads it again.
  const signedIn = !!useAccount().status.identity;
  const [directory, setDirectory] = useState<MachineAccountDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const finished = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDirectory(await machinesApi.accountList());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, signedIn]);

  const { step } = pairing;
  // Read by the unmount cleanup and by a request that answers late.
  const askingNow = useRef(asking);
  askingNow.current = asking;
  const stepNow = useRef(step);
  stepNow.current = step;
  const mounted = useRef(true);
  // Each Connect outdates the ones before: a late answer to an old one is dropped.
  const attempt = useRef(0);

  // The grant is consumed once paired, and revoked when the pairing ended for good. A failure
  // that offers Try again keeps it: the retry pairs with the same code, and a revocation could
  // remove the computer the retry paired. Back, close and leaving the tab revoke it then.
  useEffect(() => {
    const grant = asking?.grantRequestId;
    if (!grant || finished.current === grant) return;
    const paired = step.kind === "paired";
    const ended = step.kind === "fault" || (step.kind === "failed" && !failureCopy(step.reason, asking.name).retry);
    if (paired || ended) {
      finished.current = grant;
      void machinesApi.accountFinish(grant, paired).catch(() => undefined);
      if (paired) void load();
    }
  }, [asking?.grantRequestId, asking?.name, step, load]);

  /** Revoke a grant that was not used. */
  const dropGrant = (grant: string) => {
    if (finished.current === grant) return;
    finished.current = grant;
    void machinesApi.accountFinish(grant, false).catch(() => undefined);
  };

  const connect = async (machine: AccountMachine) => {
    const mine = ++attempt.current;
    setAsking({ hostId: machine.hostId, name: machine.name, grantRequestId: null, error: null });
    try {
      const offer = await machinesApi.accountRequest(machine.hostId);
      // The person left the tab, closed the dialog or went back meanwhile: never pair with it.
      if (!mounted.current || attempt.current !== mine || askingNow.current?.hostId !== machine.hostId) {
        dropGrant(offer.grantRequestId);
        return;
      }
      setAsking({ hostId: machine.hostId, name: machine.name, grantRequestId: offer.grantRequestId, error: null });
      await pairing.changeCode(offer.code);
    } catch (e) {
      if (!mounted.current || attempt.current !== mine) return;
      const message = errorMessage(e);
      if (message.startsWith("cancelled")) setAsking(null);
      else setAsking({ hostId: machine.hostId, name: machine.name, grantRequestId: null, error: requestFailure(message, machine.name) });
    }
  };

  /** Stop asking, or drop a grant that was not used: an unused grant is revoked, never left to expire. */
  const letGo = () => {
    const current = askingNow.current;
    if (!current || current.error) return;
    attempt.current++;
    const grant = current.grantRequestId;
    if (!grant) void machinesApi.accountCancel().catch(() => undefined);
    else if (stepNow.current.kind !== "paired") dropGrant(grant);
  };
  const letGoNow = useRef(letGo);
  letGoNow.current = letGo;

  // Escape, the close button and switching tabs unmount this tab: stop the request and drop the grant.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      letGoNow.current();
    };
  }, []);

  const cancelAsking = () => {
    letGo();
    pairing.cancel();
    askingNow.current = null;
    setAsking(null);
  };

  const close = () => {
    letGo();
    onClose();
  };

  // Pairing with the grant's offer: the same fingerprint and Allow as a pasted code.
  if (asking?.grantRequestId) {
    return <AccountPairing pairing={pairing} name={asking.name} onBack={cancelAsking} onClose={close} onDone={onDone} />;
  }

  let body;
  if (directory?.signedIn === false) {
    body = (
      <div className="mt-3 grid justify-items-start gap-2 rounded-lg border border-hairline px-4 py-4" data-testid="account-sign-in">
        <div className="text-[13px] font-medium">Sign in to see the computers on your account</div>
        <p className={soft}>Computers signed in to the same TerminalX account are listed here. Without an account, pair with a code or set up a headless server.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void signIn().catch(() => undefined)}>
            <LogIn /> Sign in
          </Button>
          <Button size="sm" variant="outline" onClick={onUseCode}>Use a pairing code</Button>
        </div>
      </div>
    );
  } else if (error) {
    body = (
      <div role="alert" className="mt-3 grid justify-items-start gap-2 text-[12.5px]">
        <span className="font-medium text-destructive">Could not read your account’s computers</span>
        <span className="text-muted-foreground">{error}</span>
        <Button size="sm" variant="outline" onClick={() => void load()}><RotateCw /> Try again</Button>
      </div>
    );
  } else if (!directory) {
    body = <div className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading your account…</div>;
  } else if (directory.installation !== "ready") {
    body = (
      <p role="status" className={cn(soft, "mt-3")}>
        {directory.installation === "approvalRequired"
          ? `Your account has not approved ${thisComputer} yet. Approve it from a device that is already signed in, then reopen this tab.`
          : `Your account asks ${thisComputer} to sign in again. Sign out and in under Settings → Account, then reopen this tab.`}
      </p>
    );
  } else {
    const others = directory.machines.filter((machine) => !machine.thisMac);
    const firstOnline = others.find((machine) => machine.availability === "online" && !machine.paired)?.hostId;
    body =
      others.length === 0 ? (
        <p className={cn(soft, "mt-3")} data-testid="account-empty">
          No other computer is signed in as {directory.email}. Sign in to TerminalX on it with that address, or pair it with a code.
        </p>
      ) : (
        <ul className="mt-3 rounded-lg border border-hairline" aria-label="Computers on your account">
          {others.map((machine) => {
            const dim = machine.availability !== "online";
            const mine = asking?.hostId === machine.hostId;
            return (
              <li key={machine.hostId} className="flex h-[58px] items-center gap-3 border-b border-hairline px-3.5 last:border-b-0" data-testid="account-machine" data-availability={machine.availability}>
                <MachineGlyph machine={machine} />
                <div className="min-w-0 flex-1 leading-[18px]">
                  <div className={cn("truncate text-[13px] font-medium", dim && "text-muted-foreground")}>{machine.name}</div>
                  <div className={cn("truncate text-[12px]", mine && asking?.error ? "text-destructive" : "text-faint")} title={mine && asking?.error ? asking.error : undefined}>
                    {mine && asking?.error ? asking.error : mine ? `Asking ${machine.name} for a one-time grant…` : rowLine(machine)}
                  </div>
                </div>
                {machine.paired ? (
                  <span className="shrink-0 text-[12.5px] whitespace-nowrap text-faint">In your machines</span>
                ) : machine.availability === "notAvailable" ? (
                  <span className="shrink-0 text-[12.5px] whitespace-nowrap text-faint">Not available</span>
                ) : machine.availability === "offline" ? (
                  <span className="shrink-0 text-[12.5px] whitespace-nowrap text-faint">Offline</span>
                ) : mine && !asking?.error ? (
                  <Button size="sm" variant="outline" onClick={cancelAsking}>
                    <LoaderCircle className="animate-spin" /> Cancel
                  </Button>
                ) : (
                  <Button size="sm" variant={machine.hostId === firstOnline ? "default" : "outline"} disabled={!!asking && !asking.error} onClick={() => void connect(machine)}>
                    {mine ? "Try again" : "Connect"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      );
  }

  return (
    <>
      <div className="px-5 pb-5 pt-4">
        <p className={soft}>Computers signed in to your TerminalX account. Connecting asks that computer for a one-time grant, then pairs the two directly.</p>
        {body}
        <div className="mt-3 flex items-start gap-2 text-[12px] leading-[18px] text-faint">
          <Lock className="mt-[2px] size-[13px] shrink-0" aria-hidden />
          <span>The account lists only each computer’s name and public key. Projects, sessions and terminal output never go through it.</span>
        </div>
      </div>
    </>
  );
}

/** The grant's offer is in: the person compares the fingerprint, then chooses Allow on the machine. */
function AccountPairing({ pairing, name, onBack, onClose, onDone }: { pairing: MachinePairing; name: string; onBack: () => void; onClose: () => void; onDone: () => void }) {
  const { step, inspected, route, setRoute, routeError, ask } = pairing;
  const failure = step.kind === "failed" ? failureCopy(step.reason, name) : null;
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_260px] max-[699px]:grid-cols-1" data-testid="account-pairing">
        <div className="grid min-w-0 content-start gap-3 p-5">
          {step.kind === "inspecting" || !inspected ? (
            <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Reading {name}’s answer…</div>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border border-hairline px-3 py-2.5" data-testid="machine-card">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-well">
                <PlatformIcon platform={inspected.machine.os.family} className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1 leading-5">
                <div className="truncate text-[13px] font-medium">{inspected.machine.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">{machineSummary(inspected.machine.os, inspected.machine.version)}</div>
              </div>
            </div>
          )}
          {step.kind === "invalid" && (
            <div role="alert" className="grid gap-0.5 text-[12.5px]">
              <span className="font-medium text-destructive">{name}’s answer could not be read</span>
              <span className="text-muted-foreground">{step.detail ?? "Pair with a code from that computer instead."}</span>
            </div>
          )}
          <div className="mt-1 text-[12px] font-medium uppercase tracking-[.08em] text-faint">How {thisComputer} reaches it</div>
          <Segmented aria-label={`How ${thisComputer} reaches it`} value={route} onChange={setRoute} options={ROUTE_OPTIONS} className="justify-self-start" disabled={step.kind === "paired"} />
          {routeError && <p role="alert" className="text-[12.5px] text-destructive">Paired, but the route was not saved: {routeError}</p>}
        </div>
        <div className="grid min-w-0 content-start gap-3 border-l border-hairline p-5 max-[699px]:border-l-0 max-[699px]:border-t">
          {inspected && <FingerprintBox fingerprint={inspected.fingerprint} caption={`${name} shows the same one`} />}
          {step.kind === "paired" ? (
            <div className="grid gap-1" role="status">
              <div className="flex items-center gap-2 text-[13px] font-medium text-add"><CheckCircle2 className="size-4 shrink-0" aria-hidden /> Paired with {name}</div>
              <p className={soft}>It is in Your machines and in the sidebar.</p>
            </div>
          ) : (
            <ol className={cn(soft, "grid list-decimal gap-1 pl-4 text-foreground")}>
              <li>Compare this fingerprint with the one on {name}.</li>
              <li>Choose Allow there.</li>
            </ol>
          )}
          {step.kind === "waiting" && (
            <div className="flex items-center gap-2 text-[12.5px] text-info" role="status">
              <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden /> Waiting for approval on {name}…
            </div>
          )}
          {failure && (
            <div role="alert" className="grid gap-0.5 text-[12.5px]">
              <span className="font-medium text-destructive">{failure.title}</span>
              <span className="text-muted-foreground">{step.kind === "failed" && (step.reason === "not-approved" || step.reason === "code-inactive") ? `Go back and choose Connect to ask ${name} once more.` : failure.detail}</span>
            </div>
          )}
          {step.kind === "fault" && (
            <div role="alert" className="grid gap-0.5 text-[12.5px]">
              <span className="font-medium text-destructive">Pairing stopped</span>
              <span className="break-words text-muted-foreground">{step.message}</span>
            </div>
          )}
        </div>
      </div>
      <footer className="flex min-h-14 flex-wrap items-center gap-2 border-t border-hairline px-5 py-2.5">
        <span className="mr-auto text-[12.5px] text-muted-foreground">The grant works once and lasts five minutes.</span>
        {step.kind === "paired" ? (
          <Button size="sm" onClick={onDone}>Done</Button>
        ) : (
          <>
            {failure?.retry && step.kind === "failed" && <Button variant="outline" size="sm" onClick={ask}>Try again</Button>}
            <Button variant="outline" size="sm" onClick={onBack}>Back</Button>
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          </>
        )}
      </footer>
    </>
  );
}
