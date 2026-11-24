import { useMemo, useSyncExternalStore } from "react";
import type { CloudCatalog } from "./catalog";
import { setupStoreFor, type CloudSetupStore, type OrganizationSetup } from "./setup";

const NONE: ReadonlyMap<string, OrganizationSetup> = new Map();
const none = () => NONE;
const never = () => () => undefined;

/** What each organization's provider and agent-login lists said when last read, and the store that reads them. */
export function useOrganizationSetups(catalog: CloudCatalog | null): { store: CloudSetupStore | null; setups: ReadonlyMap<string, OrganizationSetup> } {
  const store = useMemo(() => (catalog ? setupStoreFor(catalog) : null), [catalog]);
  const setups = useSyncExternalStore(store?.subscribe ?? never, store?.getSnapshot ?? none, store?.getSnapshot ?? none);
  return { store, setups };
}
