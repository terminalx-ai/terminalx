import { ACCOUNT_PAIRING_CAPABILITY, HEADLESS_PHONE_PAIRING_CAPABILITY } from "../pairing/contracts";
import type { AccountHost } from "../pairing/account-client";
import { accountHostIdentityMatches } from "../pairing/account-identity";
import type { AccountMachinePrefs } from "../store/account-machines";
import { cleanHostName, hostDisplayNames, isFallbackLabel } from "../store/host-name";
import type { StoredHost } from "../store/hosts";
import { connectionWords, type ConnectionState } from "./connection-view";

/**
 * The one list of machines on the phone (#987): every machine paired here,
 * then the machines on the account that are not, each with a name, a state
 * line, and what can be done with it now. Pure, so the screens and the
 * menu read the same answer.
 */

export type MachineTone = "connected" | "online" | "offline" | "unknown" | "attention";
export type MachineIcon = "laptop" | "desktop" | "server";
/** Why an action is off, in words for the person; null when it is on. */
export type Blocked = string | null;

interface Common {
  id: string;
  /** What to call it here: a name typed on this phone, else its own, told apart from a twin. */
  name: string;
  /** What it calls itself, when that is a real name. */
  ownName: string | null;
  /** The name typed on this phone, if any. */
  customName: string | null;
  /** Whether `name` was typed on this phone. */
  custom: boolean;
  state: string;
  tone: MachineTone;
  icon: MachineIcon;
}

export interface PairedMachine extends Common {
  kind: "paired";
  host: StoredHost;
  /** Its record on the signed-in account, when it has one. */
  account: AccountHost | null;
  active: boolean;
  connectBlocked: Blocked;
}

export interface AvailableMachine extends Common {
  kind: "available";
  host: AccountHost;
  hidden: boolean;
  pairBlocked: Blocked;
  terminalPairing: boolean;
}

export type Machine = PairedMachine | AvailableMachine;

export interface MachineInput {
  hosts: readonly StoredHost[];
  accountHosts: readonly AccountHost[];
  prefs: AccountMachinePrefs;
  activeHostId: string | null;
  /** The one connection state every screen shows (#983), for the machine in use. */
  connection: ConnectionState;
  now: number;
}

export const OFFLINE_REASON = "Open TerminalX on that machine first";
/** The account has not heard from it lately: not known to be offline, but not pairable through the account now. */
export const UNREACHABLE_REASON = "Not reachable right now. Open TerminalX on that machine";
export const INCOMPATIBLE_REASON = "Update TerminalX on that machine to pair it";
export const TERMINAL_PAIRING = "Run terminalx-serve pair --phone on the server";

/**
 * Names a machine gives itself when nobody named it: they say nothing on a
 * phone ("This Mac" is the phone's Mac to no one). "Paired Mac" is not one:
 * it is this app's own label for a desktop too old to send its name.
 */
const GENERIC_NAME = /^(this|my|the)?\s*(mac|computer|machine|pc|laptop|desktop)$|^localhost$/i;

export function isGenericName(name: string | null | undefined): boolean {
  const cleaned = cleanHostName(name);
  return cleaned === null || GENERIC_NAME.test(cleaned);
}

/** A name for a machine from what it is, for one whose own name is generic. */
export function kindName(platform: string | undefined, environment?: AccountHost["environmentKind"]): string {
  if (environment === "wsl") return "Windows (WSL)";
  if (environment === "ssh") return "SSH machine";
  const value = platform?.toLowerCase() ?? "";
  if (value === "darwin" || value === "macos" || value === "mac") return "Mac";
  if (value === "linux") return "Linux machine";
  if (value === "win32" || value === "windows") return "Windows PC";
  return "Computer";
}

export function machineList(input: MachineInput): { paired: PairedMachine[]; available: AvailableMachine[]; hidden: AvailableMachine[] } {
  // A record is trusted for a paired machine (its name, its state) only when its key gives its id.
  const byKey = new Map(input.accountHosts.filter(accountHostIdentityMatches).map((host) => [host.hostPublicKeyB64, host]));
  const pairedKeys = new Set(input.hosts.map((host) => host.publicKeyB64));
  const unpaired = input.accountHosts.filter((host) => !pairedKeys.has(host.hostPublicKeyB64));

  // One pass over every name, so a paired machine and an account one of the same name are told apart too.
  const named = [
    ...input.hosts.map((host) => {
      const account = byKey.get(host.publicKeyB64) ?? null;
      // Its own name: what it reports, else what the account calls it, else what it was saved with ("Paired Mac" is this app's, not its own).
      const own = cleanHostName([host.hostName, account?.displayName, isFallbackLabel(host.label) ? null : host.label].find((name) => !isGenericName(name)));
      const fallback = isGenericName(host.label) ? kindName(account?.platform, account?.environmentKind) : host.label;
      return { id: host.id, customName: host.customName, hostName: own ?? undefined, label: fallback, own };
    }),
    ...unpaired.map((host) => {
      const own = isGenericName(host.displayName) ? null : cleanHostName(host.displayName);
      return { id: host.hostId, customName: input.prefs[host.hostId]?.customName, hostName: own ?? undefined, label: kindName(host.platform, host.environmentKind), own };
    }),
  ];
  const names = hostDisplayNames(named);
  const ownNames = new Map(named.map((entry) => [entry.id, entry.own]));

  const paired = input.hosts.map((host): PairedMachine => {
    const account = byKey.get(host.publicKeyB64) ?? null;
    const name = names.get(host.id)!;
    const active = input.activeHostId === host.id;
    const live = account?.reachability === "live";
    // Offline only on the machine's own word that TerminalX quit ("exited"). "unverifiable" means the
    // account has no recent proof, not that it is off: it may still answer directly or over the relay.
    const offline = account?.reachability === "exited";
    const lastSeen = Math.max(account?.lastSeenAt ? Date.parse(account.lastSeenAt) || 0 : 0, host.lastConnectedAt);
    const common = { id: host.id, name, ownName: ownNames.get(host.id) ?? null, customName: cleanHostName(host.customName), custom: cleanHostName(host.customName) !== null, icon: iconFor(name, account, host) };
    if (active) {
      const { connection } = input;
      const connected = connection === "connected" || connection === "updating";
      const state = connection === "held" ? HELD_LINE : connectionWords(connection) ?? connectionWords("connecting")!;
      return { ...common, kind: "paired", host, account, active, connectBlocked: null, state, tone: connected ? "connected" : connection === "held" || connection === "waiting" ? "attention" : "unknown" };
    }
    if (offline) return { ...common, kind: "paired", host, account, active, connectBlocked: OFFLINE_REASON, state: offlineLine(lastSeen, input.now), tone: "offline" };
    if (host.disconnectedOnMacAt) return { ...common, kind: "paired", host, account, active, connectBlocked: null, state: HELD_LINE, tone: "attention" };
    if (live) return { ...common, kind: "paired", host, account, active, connectBlocked: null, state: "Online · tap to switch", tone: "online" };
    if (account) return { ...common, kind: "paired", host, account, active, connectBlocked: null, state: lastSeen > 0 ? `Last seen ${ago(lastSeen, input.now)}` : "Not seen recently", tone: "unknown" };
    return { ...common, kind: "paired", host, account, active, connectBlocked: null, state: host.lastConnectedAt > 0 ? `Last connected ${ago(host.lastConnectedAt, input.now)}` : "Not connected yet", tone: "unknown" };
  });
  // The machine in use first, then those that can be switched to, then the rest by when they were last used.
  const rank = (machine: PairedMachine) => machine.active ? 0 : machine.tone === "online" || machine.tone === "attention" ? 1 : 2;
  paired.sort((a, b) => rank(a) - rank(b) || b.host.lastConnectedAt - a.host.lastConnectedAt);

  const listed = unpaired.map((host): AvailableMachine => {
    const name = names.get(host.hostId)!;
    const verified = accountHostIdentityMatches(host);
    const terminalPairing = verified && host.capabilities.includes(HEADLESS_PHONE_PAIRING_CAPABILITY);
    const compatible = verified && host.capabilities.includes(ACCOUNT_PAIRING_CAPABILITY);
    const live = host.reachability === "live";
    const lastSeen = host.lastSeenAt ? Date.parse(host.lastSeenAt) || 0 : 0;
    const common = { id: host.hostId, name, ownName: ownNames.get(host.hostId) ?? null, customName: cleanHostName(input.prefs[host.hostId]?.customName), custom: cleanHostName(input.prefs[host.hostId]?.customName) !== null, icon: iconFor(name, host), hidden: input.prefs[host.hostId]?.hidden === true, kind: "available" as const, host, terminalPairing };
    if (terminalPairing) return { ...common, pairBlocked: null, state: TERMINAL_PAIRING, tone: live ? "online" : "unknown" };
    if (!compatible) return { ...common, pairBlocked: INCOMPATIBLE_REASON, state: INCOMPATIBLE_REASON, tone: "offline" };
    if (host.reachability === "exited") return { ...common, pairBlocked: OFFLINE_REASON, state: offlineLine(lastSeen, input.now), tone: "offline" };
    // Pairing through the account needs a live machine; an unverifiable one is not called offline.
    if (!live) return { ...common, pairBlocked: UNREACHABLE_REASON, state: lastSeen > 0 ? `Not seen recently · last seen ${ago(lastSeen, input.now)}` : "Not seen recently", tone: "unknown" };
    return { ...common, pairBlocked: null, state: "Signed in to your account", tone: "online" };
  });
  return { paired, available: listed.filter((machine) => !machine.hidden), hidden: listed.filter((machine) => machine.hidden) };
}

/** A machine disconnected on its own side: the shared words, and what a tap does. */
const HELD_LINE = `${connectionWords("held")} · tap to reconnect`;

function offlineLine(lastSeen: number, now: number): string {
  return lastSeen > 0 ? `Offline · last seen ${ago(lastSeen, now)}` : "Offline";
}

/** "just now", "5 minutes ago", "2 days ago", "3 weeks ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return unit(days, "day");
  if (days < 60) return unit(Math.floor(days / 7), "week");
  if (days < 365) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

/** A machine's mark: a server for SSH, Linux or one with no TerminalX window (PRO-359), a laptop by its name, else a desktop. */
export function iconFor(name: string, account: AccountHost | null, paired?: Pick<StoredHost, "headless" | "platform">): MachineIcon {
  if (account?.environmentKind === "ssh" || account?.platform === "linux" || account?.capabilities.includes(HEADLESS_PHONE_PAIRING_CAPABILITY)) return "server";
  if (paired?.headless === true || paired?.platform === "linux") return "server";
  return /book|laptop/i.test(name) ? "laptop" : "desktop";
}
