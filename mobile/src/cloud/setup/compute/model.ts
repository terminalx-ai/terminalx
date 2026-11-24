import type { CloudProvider, CloudProviderConnection } from "../../api";

/**
 * What board 25.03 shows for an organization's compute providers, decided
 * from the server's list alone: the app holds no provider list of its own,
 * and a provider it has never heard of is drawn the same way as the rest.
 */

/** Someone who may connect compute here: the server says so per provider (`canManage`); a member is sent none of the connection details. */
export const managesCompute = (providers: readonly CloudProvider[]) => providers.some((provider) => provider.canManage);

/** A provider with nothing to connect (no credential fields) is ready as it is. */
export const needsKey = (provider: Pick<CloudProvider, "descriptor">) => provider.descriptor.credentialFields.length > 0;

/** "One provider is enough" is said once a provider with a key is connected (25.03, "One connected"). */
export const oneConnected = (providers: readonly CloudProvider[]) => providers.some((provider) => provider.canManage && needsKey(provider) && provider.availability === "available" && provider.connection !== undefined);

/** Where a provider's row goes: a member's rows open nothing. */
export const opens = (provider: CloudProvider) => provider.canManage;

/** The connection as the provider's page shows it: what the list says, or what a connect just answered. */
export interface ShownConnection {
  state: "connected" | "attention-required";
  connectedAt: number | null;
  lastValidatedAt: number | null;
  fingerprint: string | null;
}

/**
 * What the provider's page is.
 *
 * - `member`: someone who does not manage compute sees the provider and nothing to do.
 * - `ready`: no fields, so no form and nothing to disconnect (TerminalX Cloud).
 * - `form`: not connected, or a key is being replaced.
 * - `connected`: a key is stored; its facts, Replace key and Disconnect.
 */
export type ProviderPage =
  | { kind: "member" }
  | { kind: "ready" }
  | { kind: "form"; replacing: boolean }
  | { kind: "connected"; connection: ShownConnection };

export function providerPage(provider: CloudProvider, options: { replacing: boolean; justConnected: ShownConnection | null }): ProviderPage {
  if (!provider.canManage) return { kind: "member" };
  if (!needsKey(provider)) return { kind: "ready" };
  if (options.replacing) return { kind: "form", replacing: true };
  if (options.justConnected) return { kind: "connected", connection: options.justConnected };
  const connection = listedConnection(provider);
  return connection ? { kind: "connected", connection } : { kind: "form", replacing: false };
}

/** The stored key as the list describes it; null when there is none. */
export function listedConnection(provider: CloudProvider): ShownConnection | null {
  const { connection } = provider;
  if (!connection || provider.availability === "not-connected" || connection.state === "not-connected") return null;
  const state = provider.availability === "attention-required" || connection.state === "attention-required" ? "attention-required" : "connected";
  return { state, connectedAt: connection.connectedAt, lastValidatedAt: connection.lastValidatedAt ?? null, fingerprint: connection.credentialFingerprint ?? null };
}

/** The stored key as a connect answered it; null when the answer says nothing is connected. */
export function answeredConnection(connection: CloudProviderConnection): ShownConnection | null {
  if (connection.state === "not-connected") return null;
  return { state: connection.state, connectedAt: connection.connectedAt ?? null, lastValidatedAt: connection.lastValidatedAt ?? null, fingerprint: connection.credentialFingerprint ?? null };
}

/**
 * After a connect timed out the key may have been stored: the list read
 * afterwards says whether it was. It was when the provider is now connected
 * with a key it did not have before (another fingerprint or another
 * connection time), or connected at all where it was not.
 */
export function storedAfterTimeout(before: CloudProvider | null, after: CloudProvider | null): boolean {
  const now = after?.connection;
  if (!after || !now || after.availability === "not-connected" || now.state === "not-connected") return false;
  const then = before?.connection;
  if (!then || before?.availability === "not-connected") return true;
  return then.credentialFingerprint !== now.credentialFingerprint || then.connectedAt !== now.connectedAt;
}

/** The one value the phone's route sends: the form's single field. A form of several fields cannot be sent from here. */
export function credentialOf(provider: CloudProvider, values: Readonly<Record<string, string>>): string | null {
  const fields = provider.descriptor.credentialFields;
  if (fields.length !== 1) return null;
  const value = values[fields[0]!.name] ?? "";
  return value === "" ? null : value;
}

/** The field a refusal about the key is said under: the first secret one, or the first of all. */
export const keyField = (provider: CloudProvider) => (provider.descriptor.credentialFields.find((field) => field.kind === "secret") ?? provider.descriptor.credentialFields[0])?.name ?? null;
