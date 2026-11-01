import { useSyncExternalStore } from "react";

/**
 * The sidebar's picked rows, for its bulk bar (#718): Archive, Unarchive or Delete several conversations at once.
 * Picking is apart from the open session, which a click still opens. One store for both sidebar layouts, so switching
 * layout keeps what was picked.
 *
 * A row may stand for several sessions (a branch drawn as tabs is one row for all of them); a row is picked or not as
 * a whole. Shift-click picks every row drawn between the last one picked and this one, in the order they are drawn,
 * which is read from the list itself (`ROW_ATTRIBUTE`), so a range is always what the reader sees.
 */
let picked: readonly string[] = [];
let anchor: readonly string[] | null = null;
const listeners = new Set<() => void>();

/** The attribute every pickable row carries: the ids of the sessions it stands for, space-separated. */
export const ROW_ATTRIBUTE = "data-row-sessions";

function set(next: readonly string[]) {
  picked = next;
  for (const listener of listeners) listener();
}

export function usePickedSessions(): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => picked,
    () => picked,
  );
}

export function getPickedSessions(): readonly string[] {
  return picked;
}

/** Whether every session of a row is picked. */
export function isPicked(ids: readonly string[], among: readonly string[] = picked): boolean {
  return ids.length > 0 && ids.every((id) => among.includes(id));
}

/** Pick a row, or let it go when it is picked. */
export function togglePicked(ids: readonly string[]) {
  anchor = ids;
  set(isPicked(ids) ? picked.filter((id) => !ids.includes(id)) : [...picked, ...ids.filter((id) => !picked.includes(id))]);
}

/** Pick every row drawn in `list` from the last one picked to `ids`, both included. */
export function pickRange(list: ParentNode, ids: readonly string[]) {
  const rows = [...list.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`)].map((row) => (row.getAttribute(ROW_ATTRIBUTE) ?? "").split(" ").filter(Boolean));
  const at = (row: readonly string[]) => rows.findIndex((drawn) => drawn.length === row.length && drawn.every((id) => row.includes(id)));
  const from = anchor ? at(anchor) : -1;
  const to = at(ids);
  if (from < 0 || to < 0) return togglePicked(ids);
  const between = rows.slice(Math.min(from, to), Math.max(from, to) + 1).flat();
  set([...picked, ...between.filter((id) => !picked.includes(id))]);
  anchor = ids;
}

export function clearPicked() {
  anchor = null;
  if (picked.length) set([]);
}

/**
 * What a click on a row does while picking: with ⌘ or Ctrl it picks or lets go of the row, with Shift it picks a
 * range, and once anything is picked a plain click picks too. True when the click was taken for that; otherwise the
 * row opens its session as usual.
 */
export function pickOnClick(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; currentTarget: Element }, ids: readonly string[]): boolean {
  if (event.shiftKey) {
    const list = event.currentTarget.closest("[data-testid=conversation-list]") ?? document;
    pickRange(list, ids);
    return true;
  }
  if (event.metaKey || event.ctrlKey || picked.length > 0) {
    togglePicked(ids);
    return true;
  }
  return false;
}
