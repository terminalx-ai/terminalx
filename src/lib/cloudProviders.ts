import { useSyncExternalStore, type ComponentType } from "react";
import { Box, Cloud, Container, Server, Ship } from "@/icons";
import { api, type CloudProviderDescriptor, type CloudProviderSummary } from "@/lib/api";

/**
 * What the app knows about cloud providers, all of it from the server's
 * descriptors (PRO-415): no code here or anywhere else in the app names a
 * provider. Every provider list the app reads (`api.cloudProviders`) is
 * remembered, so a workspace row that only carries a provider id still shows
 * its name and glyph, and the last list seen is kept between launches so the
 * first render before any list arrives is right too.
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
  return typeof item.id === "string" && typeof item.label === "string" && typeof item.order === "number" && Array.isArray(item.credentialFields);
}

/** Remember the descriptors of a provider list the server answered. */
export function rememberCloudProviders(providers: readonly CloudProviderSummary[]): void {
  const next = new Map(known);
  let changed = false;
  for (const provider of providers) {
    if (!provider.descriptor) continue;
    if (JSON.stringify(next.get(provider.id)) === JSON.stringify(provider.descriptor)) continue;
    next.set(provider.id, provider.descriptor);
    changed = true;
  }
  if (!changed) return;
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
 * Whether a provider bills for its machines: from its descriptor, else from
 * whether its pricing is known at all.
 */
export function cloudProviderBilled(provider: CloudProviderSummary): boolean {
  return provider.descriptor ? provider.descriptor.billedByProvider : provider.capabilities.pricing !== "unavailable";
}
