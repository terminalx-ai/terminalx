// Test fixtures only: the shapes of src/types/machines.ts as the runtime would send them.
import type { InspectedMachineCode, MachineHostStatus, MachineHostView, PairedComputer, PairedMachine, PendingComputer } from "@/types/machines";

export const CODE = "txm2.eyJ2IjoyLCJraW5kIjoibWFjaGluZSJ9";

export function inspected(patch: Partial<InspectedMachineCode> = {}): InspectedMachineCode {
  return {
    machine: { machineId: "cs1uhCLEB_ttCYaQ", name: "Mac mini", os: { family: "macos", version: "26.1" }, version: "0.2.33" },
    fingerprint: "CEF4·2468·FE26·9E4B",
    expiresAt: Date.now() + 252_000,
    directEndpoints: ["ws://192.168.1.20:6768/machine/1"],
    hasRelay: false,
    alreadyPaired: false,
    ...patch,
  };
}

export function pairedMachine(patch: Partial<PairedMachine> = {}): PairedMachine {
  return {
    machineId: "cs1uhCLEB_ttCYaQ",
    name: "Mac mini",
    os: { family: "macos", version: "26.1" },
    version: "0.2.33",
    publicKeyB64: "a2V5",
    directEndpoints: ["ws://192.168.1.20:6768/machine/1"],
    route: "relayAndNearby",
    pairedAt: Date.parse("2026-11-15T10:00:00Z"),
    lastSeenAt: null,
    ...patch,
  };
}

export function pending(patch: Partial<PendingComputer> = {}): PendingComputer {
  return {
    requestId: "req-7",
    label: "Paresh’s MacBook Pro",
    platform: "macos",
    fingerprint: "CEF4·2468·FE26·9E4B",
    transport: "direct",
    requestedAt: Date.now(),
    expiresAt: Date.now() + 118_000,
    ...patch,
  };
}

export function computer(patch: Partial<PairedComputer> = {}): PairedComputer {
  return {
    id: "computer-1",
    label: "Paresh’s MacBook Air",
    platform: "macos",
    approvedAt: Date.parse("2026-11-03T09:00:00Z"),
    lastSeenAt: Date.parse("2026-11-15T09:00:00Z"),
    connected: true,
    ...patch,
  };
}

export function hostStatus(patch: Partial<MachineHostStatus> = {}): MachineHostStatus {
  return {
    enabled: true,
    hostKey: "ready",
    machineId: "host-1",
    listening: "0.0.0.0:6768",
    takesPort: true,
    phoneRoute: false,
    computers: [],
    error: null,
    pending: null,
    code: null,
    pausedUntil: null,
    ...patch,
  };
}

export function hostView(patch: Partial<MachineHostView> = {}, status: Partial<MachineHostStatus> = {}): MachineHostView {
  return { allowOperating: true, keepAwake: true, status: hostStatus(status), ...patch };
}
