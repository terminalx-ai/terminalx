import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CloudProvider } from "./api";
import type { CloudCatalog } from "./catalog";

/** What this needs of the cloud client: an organization's provider list. */
interface ProviderList { providers(orgId: string): Promise<CloudProvider[]> }
type Names = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Each organization's providers by name (PRO-566). A workspace comes from the
 * server with its provider's id only ("agent37"); the name people know it by
 * ("Agent37") is in the organization's provider list, which a member may read
 * too. That list is asked for once for each organization while the app runs:
 * a provider's name does not change, and the list is not kept on the phone.
 * A read that fails, or a client that cannot ask at all, leaves the id as it
 * is; the next row that needs the name asks again.
 */
export class ProviderNames {
  private names: Names = new Map();
  private readonly asked = new Set<string>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly api: ProviderList) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): Names => this.names;

  /** Reads the organization's provider names, unless they were read or are being read. */
  need(orgId: string): void {
    if (this.asked.has(orgId)) return;
    this.asked.add(orgId);
    Promise.resolve().then(() => this.api.providers(orgId)).then((providers) => {
      const named = new Map(providers.flatMap((provider) => {
        const name = (provider.descriptor.label || provider.displayName).trim();
        return name ? [[provider.id, name] as const] : [];
      }));
      this.names = new Map(this.names).set(orgId, named);
      for (const listener of this.listeners) listener();
    }, () => { this.asked.delete(orgId); });
  }
}

const stores = new WeakMap<CloudCatalog, ProviderNames>();
/** One reader for a catalog: every row of an organization shares its one read. */
export function providerNamesFor(catalog: CloudCatalog): ProviderNames {
  let store = stores.get(catalog);
  if (!store) stores.set(catalog, store = new ProviderNames(catalog.api));
  return store;
}

const NONE: Names = new Map();
const none = () => NONE;
const never = () => () => undefined;

/** The name of an organization's provider, or null until its list was read (or when it does not list that id). */
export function useProviderName(catalog: CloudCatalog | null, orgId: string, providerId: string): string | null {
  const store = useMemo(() => (catalog ? providerNamesFor(catalog) : null), [catalog]);
  const names = useSyncExternalStore(store?.subscribe ?? never, store?.getSnapshot ?? none, store?.getSnapshot ?? none);
  useEffect(() => { store?.need(orgId); }, [orgId, store]);
  return names.get(orgId)?.get(providerId) ?? null;
}
