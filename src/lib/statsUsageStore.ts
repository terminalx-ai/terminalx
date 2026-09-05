import { api, errorMessage, type StatsUsageState } from "./api";

type ViewState = StatsUsageState & { initialized: boolean };

const empty: ViewState = {
  scope: "", generation: 0, snapshot: null, refreshing: false, error: null, initialized: false,
};

type StatsApi = Pick<typeof api, "statsUsageSnapshot" | "statsUsageRefresh">;

/** App lifetime, independent of page subscriptions. The backend owns durability
 * and the worker; this store keeps polling even when the last reader leaves. */
export function createStatsUsageStore(source: StatsApi = api, pollMs = 500) {
  let state = empty;
  let pending: Promise<void> | null = null;
  let request = 0;
  const listeners = new Set<() => void>();
  const publish = (next: StatsUsageState, initialized = state.initialized) => {
    state = { ...next, initialized };
    listeners.forEach((listener) => listener());
  };

  const refresh = (): Promise<void> => {
    if (pending) return pending;
    const identity = ++request;
    publish({ ...state, refreshing: true, error: null });
    pending = (async () => {
      try {
        // Revalidate the backend scope on every visit, but keep in-memory data
        // readable while the small saved-state read is in flight.
        let next = await source.statsUsageSnapshot();
        if (identity !== request) return;
        publish({ ...next, refreshing: true }, true);
        if (!next.refreshing) {
          next = await source.statsUsageRefresh(next.scope, next.generation);
          if (identity !== request) return;
          publish(next);
        }
        while (next.refreshing) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          if (identity !== request) return;
          next = await source.statsUsageSnapshot();
          if (identity !== request) return;
          publish(next);
        }
      } catch (cause) {
        if (identity === request) {
          publish({ ...state, refreshing: false, error: errorMessage(cause) });
        }
      } finally {
        if (identity === request) pending = null;
      }
    })();
    return pending;
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    /** Discard responses from a retired connection/scope (also used by HMR). */
    dispose() {
      ++request;
      pending = null;
      publish(empty, false);
      listeners.clear();
    },
  };
}

export const statsUsageStore = createStatsUsageStore();
if (import.meta.hot) import.meta.hot.dispose(() => statsUsageStore.dispose());
