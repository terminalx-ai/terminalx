import type { StoredHost } from "./hosts";

// These identities die with the in-memory diagnostics. A fresh pairing of
// the same machine cannot authorize an earlier pairing's diagnostic records.
const instances = new Map<string, symbol>();
const listeners = new Set<() => void>();
let version = 0;

export type SupportPairing = { hostId: string; instance: symbol };

export function pairingInstance(hostId: string): symbol {
  const current = instances.get(hostId);
  if (current) return current;
  const created = Symbol();
  instances.set(hostId, created);
  return created;
}

export function endPairingInstance(hostId: string): void {
  if (!instances.delete(hostId)) return;
  version++;
  for (const listener of [...listeners]) listener();
}

/**
 * The Mac or relay refused this pairing's credential (#1315): its report
 * authorization ends. A refusal that arrives after the host was paired again
 * names an earlier instance and leaves the new one alone.
 */
export function revokePairingInstance({ hostId, instance }: SupportPairing): void {
  if (instances.get(hostId) === instance) endPairingInstance(hostId);
}

/** Tells open report screens that a pairing's authorization ended; for `useSyncExternalStore`. */
export function subscribePairingInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pairingInstancesVersion(): number {
  return version;
}

export function isCurrentPairingInstance({ hostId, instance }: SupportPairing): boolean {
  return instances.get(hostId) === instance;
}

export function accountPairedHostIds(hosts: readonly StoredHost[], owner: string): Set<string> {
  return new Set(hosts.filter((host) => host.provenance.kind === "automatic" && host.provenance.userId === owner).map((host) => host.id));
}

export function supportPairingsCurrent(hosts: readonly StoredHost[], owner: string | undefined, pairings: readonly SupportPairing[]): boolean {
  if (pairings.length === 0) return true;
  if (!owner) return false;
  const permitted = accountPairedHostIds(hosts, owner);
  return pairings.every((pairing) => permitted.has(pairing.hostId) && isCurrentPairingInstance(pairing));
}
