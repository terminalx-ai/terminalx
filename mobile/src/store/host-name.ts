import type { StoredHost } from "./hosts";

/**
 * What a paired computer is called on this phone (PRO-87).
 *
 * Three names can exist for one computer, in this order of precedence:
 *
 * 1. `customName`: typed on this phone. It wins, and stays through
 *    reconnects, a rename of the computer, and app restarts. Clearing it
 *    goes back to the computer's own name.
 * 2. `hostName`: the computer's own name, as it reports it with the pairing
 *    link and again on every connection.
 * 3. `label`: what the entry was saved with. For a QR pairing that is the
 *    fallback "Paired Mac", kept for a desktop too old to send its name.
 *
 * A name is text from another device or from a text field: it is cleaned
 * and bounded before it is stored or shown, and it never identifies
 * anything. The host id does.
 */
export const HOST_NAME_MAX = 64;
export const FALLBACK_HOST_LABEL = "Paired Mac";

// Controls, and the invisible characters that reorder or hide text.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** A name fit to store and show, or null when nothing is left of it. */
export function cleanHostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s/g, " ").replace(UNPRINTABLE, "").replace(/ +/g, " ").trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, HOST_NAME_MAX).join("").trimEnd();
}

type Named = Pick<StoredHost, "label" | "hostName" | "customName">;

/** The one name to show for a computer. */
export function hostDisplayName(host: Named): string {
  return cleanHostName(host.customName) ?? cleanHostName(host.hostName) ?? cleanHostName(host.label) ?? FALLBACK_HOST_LABEL;
}

/** Whether the name shown was typed on this phone. */
export function hasCustomName(host: Named): boolean {
  return cleanHostName(host.customName) !== null;
}

/**
 * The names to show for a list of computers. Two that would read the same
 * get a short suffix from their ids, so they can be told apart: the suffix is
 * for the eye only.
 */
export function hostDisplayNames(hosts: readonly (Named & Pick<StoredHost, "id">)[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const host of hosts) groups.set(hostDisplayName(host), [...(groups.get(hostDisplayName(host)) ?? []), host.id]);
  const shown = new Map<string, string>();
  for (const [name, ids] of groups) {
    if (ids.length === 1) {
      shown.set(ids[0]!, name);
      continue;
    }
    // The shortest ending of the ids (four characters or more) that differs for each; failing that, a count.
    const plain = ids.map((id) => id.replace(/[^A-Za-z0-9]/g, ""));
    const longest = Math.max(...plain.map((id) => id.length));
    let length = 4;
    while (length <= longest && new Set(plain.map((id) => id.slice(-length))).size < ids.length) length++;
    const distinct = length <= longest;
    ids.forEach((id, index) => shown.set(id, `${name} · ${distinct ? plain[index]!.slice(-length) : index + 1}`));
  }
  return shown;
}

/** `host` with what the computer now calls itself; the same object when nothing changed. */
export function withHostName<T extends StoredHost>(host: T, reported: unknown): T {
  const hostName = cleanHostName(reported);
  return hostName && hostName !== host.hostName ? { ...host, hostName } : host;
}

/** `host` renamed on this phone; an empty name goes back to the computer's own. */
export function withCustomName<T extends StoredHost>(host: T, typed: string): T {
  const customName = cleanHostName(typed);
  const { customName: _previous, ...rest } = host;
  return (customName ? { ...rest, customName } : rest) as T;
}
