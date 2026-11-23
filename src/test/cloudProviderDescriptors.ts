import type { CloudProviderDescriptor, CloudProviderSummary } from "@/lib/api";
import { rememberCloudProviders } from "@/lib/cloudProviders";

// The descriptors the server's provider registry publishes (terminalx-saas
// PRO-415), as a `/cloud-providers` answer carries them. The app names no
// provider: a test that shows provider names or orders providers learns them
// the way the app does, from a provider list it has read.

const base = {
  capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
  offering: { locations: "required", sources: "optional", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" },
  allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0],
  allowedRetentionDays: [7, 30],
};

export const DESCRIPTORS: Record<string, CloudProviderDescriptor> = {
  // A provider TerminalX itself provides (PRO-452): `credentialSource` says
  // `platform` and nobody is asked for a credential. The others are an
  // organization's; a server older than platform providers leaves the field
  // out, which `describedAs(id, { credentialSource: undefined })` stands for.
  "terminalx-cloud": {
    ...base,
    id: "terminalx-cloud",
    label: "TerminalX Cloud",
    icon: "cloud",
    order: 5,
    description: "Machines on TerminalX Cloud. Nothing to connect: they are ready to use.",
    billing: "Billed by TerminalX",
    billedByProvider: false,
    listed: true,
    credentialSource: "platform",
    credentialFields: [],
  },
  box: {
    ...base,
    id: "box",
    label: "Boat",
    icon: "ship",
    order: 10,
    description: "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume.",
    billing: "Per second, billed by Boat",
    billedByProvider: true,
    listed: true,
    credentialSource: "organization",
    credentialFields: [{ name: "credential", kind: "secret", label: "Boat API token", helpUrl: null }],
    capabilities: { ...base.capabilities, computeRunsUntilStopped: true },
  },
  hetzner: {
    ...base,
    id: "hetzner",
    label: "Hetzner Cloud",
    icon: "server",
    order: 20,
    description: "Machines in Falkenstein, Nuremberg, Helsinki, Ashburn and Hillsboro.",
    billing: "Hourly, billed by Hetzner",
    billedByProvider: true,
    listed: true,
    credentialSource: "organization",
    credentialFields: [{ name: "credential", kind: "secret", label: "Hetzner API token", helpUrl: "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token" }],
    offering: { ...base.offering, suspendedBilling: "full-rate" },
  },
  machine0: {
    ...base,
    id: "machine0",
    label: "Machine0",
    icon: "cloud",
    order: 30,
    description: "Cloud machines in your Machine0 account.",
    billing: "Billed by Machine0",
    billedByProvider: true,
    listed: true,
    credentialSource: "organization",
    credentialFields: [{ name: "credential", kind: "secret", label: "Machine0 API token", helpUrl: null }],
    offering: { ...base.offering, suspendedBilling: "unknown" },
  },
  "local-docker": {
    ...base,
    id: "local-docker",
    label: "Local Docker (development)",
    icon: "container",
    order: 90,
    description: "Containers on a machine you run. Good for trying cloud workspaces out.",
    billing: "Your own hardware",
    billedByProvider: false,
    listed: true,
    credentialSource: "organization",
    credentialFields: [{ name: "credential", kind: "text", label: "Connection marker: local-docker: then 16 to 64 letters, digits, - or _", helpUrl: null }],
  },
};

/** A descriptor as the server sends it, `listed: false` for a provider it hides. */
export function describedAs(id: string, overrides: Partial<CloudProviderDescriptor> = {}): CloudProviderDescriptor {
  return { ...DESCRIPTORS[id]!, ...overrides };
}

/** The app has read a provider list that described these providers (all of them by default). */
export function learnDescriptors(ids: readonly string[] = Object.keys(DESCRIPTORS)): void {
  rememberCloudProviders(ids.map((id) => ({ id, descriptor: DESCRIPTORS[id]! }) as CloudProviderSummary));
}
