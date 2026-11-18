import { useEffect, useRef, useState } from "react";
import { useSecondsLeft } from "@/components/pairing/pairingText";
import { errorMessage } from "@/lib/api";
import { machinesApi } from "@/lib/machines";
import { dismissMachineToast, noteMachinePairFailed } from "@/lib/machineToasts";
import { MACHINE_CODE_PREFIX, type InspectedMachineCode, type MachinePairingFailure, type MachineRoute, type PairedMachine } from "@/types/machines";

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

export type PairingStep =
  | { kind: "empty" }
  | { kind: "inspecting" }
  | { kind: "invalid"; detail: string | null }
  /** Read and named, not asked yet: the Headless server tab waits for Continue. */
  | { kind: "ready"; inspected: InspectedMachineCode }
  | { kind: "waiting"; inspected: InspectedMachineCode }
  | { kind: "paired"; inspected: InspectedMachineCode; machine: PairedMachine }
  | { kind: "failed"; inspected: InspectedMachineCode; reason: MachinePairingFailure }
  | { kind: "fault"; inspected: InspectedMachineCode; message: string };

/**
 * One pasted machine code and the pairing it starts, shared by the Pairing code
 * and Headless server tabs so both pair the same way: inspect, `machines_pair`
 * with the route chosen when Allow arrives, then save that route if it differs.
 * `askOnRead` asks at once once the code is read (Pairing code); otherwise the
 * code waits in `ready` until `ask()` (Headless server's Continue).
 */
export function useMachinePairing({ askOnRead, onPaired }: { askOnRead: boolean; onPaired?: (machine: PairedMachine) => void }) {
  const [code, setCode] = useState("");
  const [step, setStep] = useState<PairingStep>({ kind: "empty" });
  const [route, setRoute] = useState<MachineRoute>("relayAndNearby");
  const [routeError, setRouteError] = useState<string | null>(null);
  // The route chosen when Allow arrives wins, so it stays live while waiting.
  const routeNow = useRef(route);
  routeNow.current = route;
  // Each paste or attempt outdates the ones before: a late answer to an old one is dropped.
  const attempt = useRef(0);
  const waitingNow = useRef(false);
  waitingNow.current = step.kind === "waiting";

  const inspected = "inspected" in step ? step.inspected : null;
  const remaining = useSecondsLeft(inspected?.expiresAt ?? null);

  // A pairing that fails while the person is away from this window (at the other
  // computer, choosing Allow) also says so as a toast (21.09); the next attempt,
  // or closing the dialog, takes it back.
  const failedToast = useRef<string | null>(null);
  const clearFailedToast = () => {
    if (failedToast.current) dismissMachineToast(failedToast.current);
    failedToast.current = null;
  };
  useEffect(() => clearFailedToast, []);
  const toastFailure = (found: InspectedMachineCode, reason: MachinePairingFailure, text: string) => {
    if (typeof document === "undefined" || document.hasFocus()) return;
    const copy = failureCopy(reason, found.machine.name);
    failedToast.current = noteMachinePairFailed(found.machine.name, copy.detail, copy.retry ? () => void pair(text, found) : null);
  };

  const pair = async (text: string, found: InspectedMachineCode) => {
    clearFailedToast();
    const mine = ++attempt.current;
    waitingNow.current = true;
    setStep({ kind: "waiting", inspected: found });
    try {
      const result = await machinesApi.pair(text, routeNow.current);
      if (attempt.current !== mine) return;
      if (!result.paired) {
        if (result.reason === "cancelled") return;
        setStep({ kind: "failed", inspected: found, reason: result.reason });
        toastFailure(found, result.reason, text);
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
      // The code names the machine and the fingerprint: the person compares while it waits.
      if (askOnRead) void pair(text, found);
      else setStep({ kind: "ready", inspected: found });
    } catch (error) {
      if (attempt.current === mine) setStep({ kind: "invalid", detail: errorMessage(error) });
    }
  };

  /** Ask the read code's machine (Continue, or Try again). */
  const ask = () => {
    if (inspected) void pair(code.trim(), inspected);
  };

  /** Cancels a pairing that waits on the machine and drops its answer; the code stays to try again. */
  const cancel = () => {
    if (waitingNow.current && inspected) {
      attempt.current++;
      waitingNow.current = false;
      setStep({ kind: "failed", inspected, reason: "cancelled" });
      void machinesApi.cancelPairing().catch(() => undefined);
    }
  };

  return { code, step, inspected, remaining, route, setRoute, routeError, changeCode, ask, cancel };
}

export type MachinePairing = ReturnType<typeof useMachinePairing>;
