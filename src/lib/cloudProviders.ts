import { useSyncExternalStore, type ComponentType } from "react";
import { Box, Cloud, Container, Server, Ship } from "@/icons";
import { api, type CloudProviderCredentialSource, type CloudProviderDescriptor, type CloudProviderSummary } from "@/lib/api";

/**
 * What the app knows about cloud providers, all of it from the server's
 * descriptors (PRO-415): no code here or anywhere else in the app names a
 * provider. The last provider list the app read (`api.cloudProviders`) is
 * kept, between launches too, so a workspace row that only carries a provider
 * id shows its name and glyph from the first render. Components that show a
 * name by id subscribe with `useCloudProviderDescriptors`, so they update when
 * a list arrives.
 */

const STORAGE_KEY = "terminalx.cloudProviderDescriptors.v1";

type Known = ReadonlyMap<string, CloudProviderDescriptor>;

let known: Known = load();
const listeners = new Set<() => void>();

function load(): Known {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return new Map();
    return new Map(stored.filter(isDescriptor).map((descriptor) => [descriptor.id, descriptor]));
  } catch {
    return new Map();
  }
}

function isDescriptor(value: unknown): value is CloudProviderDescriptor {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CloudProviderDescriptor>;
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.order === "number" && typeof item.listed === "boolean" && Array.isArray(item.credentialFields);
}

/**
 * Take the descriptors of a provider list the server answered. A list is the
 * whole registry as this organization sees it, so it replaces what was known:
 * a provider the server no longer has, or one learned from another server (a
 * development server's local Docker), is gone with the next list. The one
 * exception is a hidden provider (`listed: false`): the server lists it only
 * to an organization still connected to it, so another organization's list
 * leaving it out does not mean it is gone, and its workspaces elsewhere keep
 * their name. A hidden provider never gets a row of its own (see
 * `cloudProviderOffered`).
 */
export function rememberCloudProviders(providers: readonly CloudProviderSummary[]): void {
  const inList = new Set(providers.map((provider) => provider.id));
  const next = new Map<string, CloudProviderDescriptor>();
  for (const [id, descriptor] of known) if (!descriptor.listed && !inList.has(id)) next.set(id, descriptor);
  for (const provider of providers) if (provider.descriptor) next.set(provider.id, provider.descriptor);
  const fingerprint = (map: Known) => JSON.stringify([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
  if (fingerprint(next) === fingerprint(known)) return;
  known = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...known.values()]));
  } catch {
    // A full or blocked storage only costs the next launch its first labels.
  }
  for (const listener of listeners) listener();
}

let learning = false;

/**
 * Read the provider list once in this app's life when a workspace names a
 * provider the app has no descriptor for, so its name and glyph are right on
 * a first launch before Settings or New Session read the list. A failed read
 * is not retried here: the next list Settings or New Session reads fills it.
 */
export function learnCloudProviders(providers: Iterable<string | null | undefined>): void {
  if (learning) return;
  for (const provider of providers) {
    if (!provider || known.has(provider)) continue;
    learning = true;
    void Promise.resolve()
      .then(() => api.cloudProviders())
      .catch(() => undefined);
    return;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The descriptors the app knows, re-rendering when a provider list brings new ones. */
export function useCloudProviderDescriptors(): Known {
  return useSyncExternalStore(subscribe, () => known, () => known);
}

export function cloudProviderDescriptor(provider: string | null | undefined): CloudProviderDescriptor | null {
  return provider ? (known.get(provider) ?? null) : null;
}

/** A provider's name: its descriptor's label, else what the list called it, else its id. */
export function cloudProviderLabel(provider: string | CloudProviderSummary): string {
  if (typeof provider !== "string") return provider.descriptor?.label || provider.displayName || provider.id;
  return known.get(provider)?.label ?? provider;
}

/**
 * The glyph a descriptor's `icon` word stands for. The words are generic
 * shapes, not providers; an unknown one is drawn as a cloud.
 */
const GLYPHS: Record<string, ComponentType<{ className?: string }>> = { ship: Ship, server: Server, cloud: Cloud, container: Container, box: Box };

export function cloudProviderIcon(provider: string | CloudProviderSummary | CloudProviderDescriptor | null | undefined): ComponentType<{ className?: string }> {
  const descriptor = !provider ? null : typeof provider === "string" ? known.get(provider) : "descriptor" in provider ? provider.descriptor : provider;
  return (descriptor && GLYPHS[descriptor.icon]) || Cloud;
}

/**
 * Provider ids in their descriptors' order; an id without a known descriptor
 * goes after every described one, ids breaking ties so the order never
 * depends on how a map happened to sort them.
 */
export function orderedCloudProviderIds(ids: readonly string[]): string[] {
  const order = (id: string) => known.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
  return [...ids].sort((left, right) => order(left) - order(right) || (left < right ? -1 : left > right ? 1 : 0));
}

/** A descriptor's `order`; a provider without one goes after every described one. */
function orderOf(provider: CloudProviderSummary): number {
  return provider.descriptor?.order ?? Number.MAX_SAFE_INTEGER;
}

/** Providers in the order their descriptors give, the server's order breaking ties. */
export function orderedCloudProviders<T extends CloudProviderSummary>(providers: readonly T[]): T[] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => orderOf(left.provider) - orderOf(right.provider) || left.index - right.index)
    .map(({ provider }) => provider);
}

/**
 * False for a hidden provider: the server lists it only because the
 * organization is still connected to it, so it can disconnect. It is never a
 * new choice, and allowing new machines on it would not offer it. A provider
 * without a descriptor (an older server) counts as offered.
 */
export function cloudProviderOffered(provider: CloudProviderSummary): boolean {
  return provider.descriptor?.listed !== false;
}

/**
 * Whose credential a provider runs on (PRO-452): `platform` only when its
 * descriptor says exactly that. A descriptor without the field (an older
 * server), a value this app does not know, and a provider without a
 * descriptor are all `organization`, the only kind there was. A provider id
 * is looked up among the descriptors the app has read.
 */
export function cloudProviderCredentialSource(provider: string | CloudProviderSummary | CloudProviderDescriptor | null | undefined): CloudProviderCredentialSource {
  const descriptor = !provider ? null : typeof provider === "string" ? known.get(provider) : "descriptor" in provider ? provider.descriptor : provider;
  return descriptor?.credentialSource === "platform" ? "platform" : "organization";
}

/**
 * True for a provider TerminalX itself provides: there is no key to connect,
 * replace, check or disconnect, and no connection of the organization's to
 * read. It is ready to use from the start.
 */
export function cloudProviderIsPlatform(provider: string | CloudProviderSummary | CloudProviderDescriptor | null | undefined): boolean {
  return cloudProviderCredentialSource(provider) === "platform";
}

/**
 * Whether the organization has this provider in place: a connection it made
 * (which the list shows to whoever may manage it), or a platform provider,
 * which needs none.
 */
export function cloudProviderInPlace(provider: CloudProviderSummary): boolean {
  return Boolean(provider.connection) || cloudProviderIsPlatform(provider);
}

/**
 * In place and working: a connection that is connected, or a platform
 * provider that does not need attention.
 */
export function cloudProviderReady(provider: CloudProviderSummary): boolean {
  if (cloudProviderIsPlatform(provider)) return provider.availability === "available" || provider.availability === "disabled-for-create";
  return provider.connection?.state === "connected";
}

/** What a platform provider says wherever a connected provider would show its key. */
export const PLATFORM_PROVIDER_NOTE = "Provided by TerminalX";

/**
 * Whether a provider bills for its machines: from its descriptor, else from
 * whether its pricing is known at all.
 */
export function cloudProviderBilled(provider: CloudProviderSummary): boolean {
  return provider.descriptor ? provider.descriptor.billedByProvider : provider.capabilities.pricing !== "unavailable";
}
