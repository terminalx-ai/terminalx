/** Wire contract: computer_targets.rs. Support does not establish readiness. */
export type ComputerTarget =
  | { kind: "linuxContainer"; runtime: "docker" | "podman"; id: string }
  | { kind: "macosGuest"; environmentId: string; generation: string };
export type ComputerCapability = "attachedDesktop" | "guestTask";
export interface ComputerEntry { target: ComputerTarget; name: string; capabilities: ComputerCapability[]; state: string }
export interface ComputerInventory { entries: ComputerEntry[]; notices: string[] }
export interface ComputerSelection { version: 1; conversation: string | null; target: ComputerTarget | null }
export interface ComputerContext { sessionId: string; tabId: string; conversation: string | null }

export function computerKey(target: ComputerTarget): string {
  return target.kind === "linuxContainer" ? JSON.stringify([target.kind, target.runtime, target.id]) : JSON.stringify([target.kind, target.environmentId, target.generation]);
}
