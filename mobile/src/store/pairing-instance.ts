import type { StoredHost } from "./hosts";

// These identities die with the in-memory diagnostics. A fresh pairing of
// the same machine cannot authorize an earlier pairing's diagnostic records.
const instances = new Map<string, symbol>();

export type SupportPairing = { hostId: string; instance: symbol };

export function pairingInstance(hostId: string): symbol {
  const current = instances.get(hostId);
  if (current) return current;
  const created = Symbol();
  instances.set(hostId, created);
  return created;
}

export function endPairingInstance(hostId: string): void {
  instances.delete(hostId);
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
