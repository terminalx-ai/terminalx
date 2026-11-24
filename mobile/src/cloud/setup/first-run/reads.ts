import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { CloudApiError, type CloudOrganization } from "../../api";
import type { CloudCatalog } from "../../catalog";
import { managesSetup, NOT_ASKED, READING, type LoginsPart, type OrganizationReads, type Part } from "./steps";

/**
 * What the setup steps are read from, per organization: its providers and,
 * for its owners and admins, its agent logins (25.01). Held in memory for the
 * signed-in catalog only, so the Cloud tab, the organization page and the
 * organization's own page show one answer; nothing of it is written to the
 * phone. Reading starts nothing: two GETs per organization, and only when a
 * screen asks.
 *
 * Also the organization the person chose on the organization page (25.02),
 * for as long as the app runs: which one is being set up is the person's
 * choice, everything else about it the server's.
 */
class SetupReads {
  private readonly reads = new Map<string, OrganizationReads>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  chosen: string | null = null;

  constructor(private readonly catalog: CloudCatalog) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = () => this.version;

  get(orgId: string): OrganizationReads | null {
    return this.reads.get(orgId) ?? null;
  }

  choose(orgId: string): void {
    this.chosen = orgId;
    this.publish();
  }

  /** Read the organization's lists unless they were read already. */
  ensure(organization: Pick<CloudOrganization, "orgId" | "role" | "isPersonal">): Promise<void> {
    return this.reads.has(organization.orgId) ? this.flights.get(organization.orgId) ?? Promise.resolve() : this.read(organization);
  }

  /** Read them again; what was read before stays shown until the answer comes, and after a failure. */
  read(organization: Pick<CloudOrganization, "orgId" | "role" | "isPersonal">): Promise<void> {
    const { orgId } = organization;
    const running = this.flights.get(orgId);
    if (running) return running;
    const before = this.reads.get(orgId);
    if (!before) {
      this.reads.set(orgId, { providers: READING, logins: managesSetup(organization) ? READING : NOT_ASKED });
      this.publish();
    }
    const api = this.catalog.api;
    const providers = settle(() => api.providers(orgId), before?.providers ?? null);
    const loginsBefore = before && before.logins.state !== "not-asked" ? before.logins : null;
    const logins: Promise<LoginsPart> = managesSetup(organization) ? settle(() => api.credentials(orgId), loginsBefore) : Promise.resolve(NOT_ASKED);
    const flight = Promise.all([providers, logins]).then(([providersPart, loginsPart]) => {
      this.reads.set(orgId, { providers: providersPart, logins: loginsPart });
      this.publish();
    }).finally(() => { this.flights.delete(orgId); });
    this.flights.set(orgId, flight);
    return flight;
  }

  private publish(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The answer to one read. A failure keeps what was read before; anything
 * thrown that is not the client's own error is said as an answer this app
 * could not read, never as done or missing.
 */
async function settle<T>(read: () => Promise<T>, before: Part<T> | null): Promise<Part<T>> {
  try {
    return { state: "read", value: await read(), error: null };
  } catch (caught) {
    const error = caught instanceof CloudApiError ? caught : new CloudApiError("cloud_workspace_invalid_response", 200);
    return { state: "failed", value: before?.value ?? null, error };
  }
}

const stores = new WeakMap<CloudCatalog, SetupReads>();

function storeFor(catalog: CloudCatalog): SetupReads {
  let store = stores.get(catalog);
  if (!store) {
    store = new SetupReads(catalog);
    stores.set(catalog, store);
  }
  return store;
}

const noop = () => () => undefined;

export interface SetupReadsView {
  get(orgId: string): OrganizationReads | null;
  chosen: string | null;
  choose(orgId: string): void;
  /** Read these organizations' lists again (a pull, or the page coming back into view). */
  refresh(organizations: readonly Pick<CloudOrganization, "orgId" | "role" | "isPersonal">[]): Promise<void>;
}

/**
 * The setup reads of the signed-in catalog, reading `organizations` that
 * were not read yet. Signed out (no catalog) nothing is read.
 */
export function useSetupReads(catalog: CloudCatalog | null, organizations: readonly Pick<CloudOrganization, "orgId" | "role" | "isPersonal">[]): SetupReadsView {
  const store = catalog ? storeFor(catalog) : null;
  const version = useSyncExternalStore(store?.subscribe ?? noop, store?.getVersion ?? (() => 0), store?.getVersion ?? (() => 0));
  const key = organizations.map((entry) => `${entry.orgId}:${entry.role}:${entry.isPersonal === true}`).join("|");
  useEffect(() => {
    if (!store) return;
    for (const organization of organizations) void store.ensure(organization);
    // `key` names the organizations and roles: the array itself is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, key]);
  const refresh = useCallback(async (list: readonly Pick<CloudOrganization, "orgId" | "role" | "isPersonal">[]) => { if (store) await Promise.all(list.map((organization) => store.read(organization))); }, [store]);
  return useMemo(() => ({
    get: (orgId: string) => store?.get(orgId) ?? null,
    chosen: store?.chosen ?? null,
    choose: (orgId: string) => store?.choose(orgId),
    refresh,
    // `version` is what changes when a read answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [store, version, refresh]);
}
