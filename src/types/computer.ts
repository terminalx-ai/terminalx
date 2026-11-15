/** Wire contract: computer_targets.rs. Support does not establish readiness. */
export type ComputerTarget =
  | { kind: "linuxContainer"; runtime: "docker" | "podman"; id: string }
  | { kind: "linuxGuest"; runtime: "docker" | "podman"; id: string; environmentId: string; generation: string }
  | { kind: "macosGuest"; environmentId: string; generation: string };
export type ComputerCapability = "attachedDesktop" | "guestTask";
export interface ComputerEntry { target: ComputerTarget; name: string; capabilities: ComputerCapability[]; state: string }
export interface ComputerInventory { entries: ComputerEntry[]; notices: string[] }
export interface ComputerSelection { version: 1; conversation: string | null; target: ComputerTarget | null }
export interface ComputerContext { sessionId: string; tabId: string; conversation: string | null }

export function computerKey(target: ComputerTarget): string {
  if (target.kind === "linuxGuest") return JSON.stringify([target.kind, target.runtime, target.id, target.environmentId, target.generation]);
  return target.kind === "linuxContainer" ? JSON.stringify([target.kind, target.runtime, target.id]) : JSON.stringify([target.kind, target.environmentId, target.generation]);
}

/** Linux acknowledgments must retain the full transport, not just VM IDs. */
export function taskComputerMatches(target: ComputerTarget, task: import("./localVm").LocalVmTask): boolean {
  if (target.kind === "linuxContainer" || task.target.environmentId !== target.environmentId || task.target.generation !== target.generation) return false;
  if (target.kind === "linuxGuest") return !!task.computer && computerKey(task.computer) === computerKey(target);
  return !task.computer || computerKey(task.computer) === computerKey(target);
}

export function environmentComputer(environment: import("./localVm").LocalVmEnvironment): ComputerTarget {
  const transport = environment.transport;
  return transport?.kind === "linuxContainer"
    ? { kind: "linuxGuest", runtime: transport.runtime, id: transport.id, environmentId: environment.id, generation: environment.generation }
    : { kind: "macosGuest", environmentId: environment.id, generation: environment.generation };
}
