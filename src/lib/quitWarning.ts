import { api } from "@/lib/api";

/**
 * Work that quitting the app would cut short. While any is held, the app
 * asks before it quits or its main window closes (`quit.rs`).
 */
const held = new Map<symbol, string>();

function tell() {
  const warning = [...held.values()].at(-1) ?? null;
  // Outside the desktop app there is nothing to tell, and nothing to quit.
  void Promise.resolve()
    .then(() => api.setQuitWarning(warning))
    .catch(() => undefined);
}

/** Ask before quitting until the returned function is called. `warning` says what would be cut short. */
export function holdQuit(warning: string): () => void {
  const key = Symbol();
  held.set(key, warning);
  tell();
  return () => {
    if (held.delete(key)) tell();
  };
}
