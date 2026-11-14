/**
 * The files last opened in each checkout, newest first, for Open file
 * (PRO-298). Kept per checkout, by the file source's key (`local:<root>` or a
 * cloud workspace's key): sessions that share a worktree share its list,
 * and a path is never offered in a tree it was not opened in. Saved in this
 * window's storage so the list outlives a restart.
 */

const KEY = "terminalx.recentFiles";
/** Paths kept per checkout. */
const PER_CHECKOUT = 30;
/** Checkouts kept; the one opened in longest ago goes first. */
const CHECKOUTS = 40;

interface Stored {
  /** Checkout key → paths, newest first. Insertion order is least recently used first. */
  [key: string]: string[];
}

function load(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Stored = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, PER_CHECKOUT);
    }
    return out;
  } catch {
    return {};
  }
}

function save(stored: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage can be unavailable or full; the list then lasts only as long as it is read.
  }
}

/** Note that `rel` was just opened in the checkout `key`. */
export function recordRecentFile(key: string, rel: string): void {
  if (!key || !rel) return;
  const stored = load();
  const paths = [rel, ...(stored[key] ?? []).filter((p) => p !== rel)].slice(0, PER_CHECKOUT);
  delete stored[key];
  stored[key] = paths;
  const keys = Object.keys(stored);
  for (const old of keys.slice(0, Math.max(0, keys.length - CHECKOUTS))) delete stored[old];
  save(stored);
}

/** The checkout's recently opened files, newest first. */
export function recentFiles(key: string): string[] {
  return load()[key] ?? [];
}

/** Drop paths that are gone, so the list does not keep offering them. */
export function forgetRecentFiles(key: string, gone: string[]): void {
  if (!gone.length) return;
  const stored = load();
  const paths = stored[key];
  if (!paths) return;
  stored[key] = paths.filter((p) => !gone.includes(p));
  save(stored);
}
