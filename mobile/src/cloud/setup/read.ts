import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { CloudApiError, type CloudApi } from "../api";
import { useCloudCatalog } from "../CloudProvider";

/**
 * Reads for the cloud setup screens (boards 25.01 to 25.06): the signed-in
 * account's API client, and one read with the three states a step can be in.
 */

/** The signed-in catalog's client, or null while signed out. */
export function useCloudApi(): CloudApi | null {
  return useCloudCatalog()?.api ?? null;
}

/**
 * One read as a screen shows it.
 *
 * - `reading`: nothing has been read yet (the first read, or the first since
 *   what it depends on changed). There is no value to show.
 * - `read`: `value` is the last answer.
 * - `could-not-be-read`: the last read failed with `error`. `value` is what was
 *   read before, if anything was, so a failed refresh never empties a page.
 *
 * `refreshing` is true while a read is under way over something already
 * shown, and `refresh()` reads again, resolving when that read has finished.
 */
export type ReadState<T> = (
  | { state: "reading"; value: null; error: null }
  | { state: "read"; value: T; error: null }
  | { state: "could-not-be-read"; value: T | null; error: CloudApiError }
) & { refreshing: boolean; refresh: () => Promise<void> };

export interface ReadOptions {
  /** Read again each time the page comes back into view (not on its first showing, which reads already). */
  refreshOnFocus?: boolean;
}

type Shown<T> = { state: "reading"; value: null; error: null } | { state: "read"; value: T; error: null } | { state: "could-not-be-read"; value: T | null; error: CloudApiError };
const READING = { state: "reading", value: null, error: null } as const;

/**
 * Reads `read(api)` while signed in, again whenever a value in `deps` changes,
 * on `refresh()`, and, if asked, when the page comes back into view. Only the
 * newest read is shown: an answer to a read that was overtaken is dropped.
 * Signed out there is no client, so nothing is read and the state stays
 * `reading`; the screens show the signed-out page from `useCloudApi()`.
 *
 * Nothing is ever made up: a value is only what a read answered, and a failure
 * carries the client's own CloudApiError. Anything else thrown is a fault in
 * the read itself and is raised to the screen's error boundary.
 */
export function useRead<T>(read: (api: CloudApi) => Promise<T>, deps: DependencyList, options: ReadOptions = {}): ReadState<T> {
  const api = useCloudApi();
  const [shown, setShown] = useState<Shown<T>>(READING);
  const [refreshing, setRefreshing] = useState(false);
  const [, raise] = useState<null>(null);
  const latest = useRef(0);
  // The newest read function, so a caller's inline arrow does not count as a change; `deps` says when it reads something else.
  const readRef = useRef(read);
  useEffect(() => { readRef.current = read; });

  const run = useCallback(async (fresh: boolean) => {
    const id = ++latest.current;
    if (!api) {
      setShown(READING);
      setRefreshing(false);
      return;
    }
    if (fresh) setShown(READING);
    setRefreshing(!fresh);
    try {
      const value = await readRef.current(api);
      if (id !== latest.current) return;
      setShown({ state: "read", value, error: null });
    } catch (error) {
      if (id !== latest.current) return;
      if (!(error instanceof CloudApiError)) {
        raise(() => { throw error; });
        return;
      }
      setShown((before) => ({ state: "could-not-be-read", value: before.value, error }));
    } finally {
      if (id === latest.current) setRefreshing(false);
    }
  }, [api]);

  // A new client or new inputs are a different read: what was shown for the old ones is not kept.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void run(true); return () => { latest.current += 1; }; }, [run, ...deps]);

  const refresh = useCallback(() => run(false), [run]);

  // Coming back into view reads again when asked; the first showing is the read above, so it is not read twice.
  const onFocus = useRef({ refresh, again: options.refreshOnFocus === true });
  useEffect(() => { onFocus.current = { refresh, again: options.refreshOnFocus === true }; });
  const focusedBefore = useRef(false);
  useFocusEffect(useCallback(() => {
    if (focusedBefore.current && onFocus.current.again) void onFocus.current.refresh();
    focusedBefore.current = true;
  }, []));

  return { ...shown, refreshing, refresh } as ReadState<T>;
}
