/**
 * Stored shortcuts from an older version, as this version reads them. It
 * imports nothing: the preferences load through here before the shortcut
 * registry exists.
 *
 * Version 2 (#427): the Escape action became two. `session.stop` used to be
 * "Stop the running turn" on Escape, and it ended the agent's process. It is
 * now the explicit hard stop with no keys of its own, and `session.interrupt`
 * is what Escape does. Keys the reader chose for the old action were chosen
 * for stopping a turn, so they move to the interrupt (an empty list too:
 * someone who took the action off Escape keeps Escape free), and the hard
 * stop starts with none. Nobody ends up with a key that ends the process
 * without having asked for one.
 */
export const SHORTCUTS_VERSION = 2;

/** The version of stored shortcuts: 1 for the ones saved before versions were recorded. */
export function shortcutsVersionOf(stored: unknown): number {
  return typeof stored === "number" && Number.isFinite(stored) ? stored : 1;
}

/** `stored` as this version reads it; the same object when there is nothing to change. */
export function migrateShortcuts<T>(stored: T, from: number): T | Record<string, unknown> {
  if (from >= 2 || !stored || typeof stored !== "object" || Array.isArray(stored) || !("session.stop" in stored)) return stored;
  const { "session.stop": chosen, ...rest } = stored as Record<string, unknown>;
  return "session.interrupt" in rest ? rest : { ...rest, "session.interrupt": chosen };
}
