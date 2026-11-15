import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A list's pull to refresh (#983): its spinner shows only because the person
 * pulled, and stays until that refresh has ended. A refresh the app starts by
 * itself never shows it; the connection line says what is under way instead.
 */
export function usePullRefresh(refresh: () => Promise<unknown> | undefined): { refreshing: boolean; onRefresh(): void } {
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void Promise.resolve(refresh()).catch(() => undefined).finally(() => { if (mounted.current) setRefreshing(false); });
  }, [refresh]);
  return { refreshing, onRefresh };
}
