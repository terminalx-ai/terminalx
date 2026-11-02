import { useEffect, useState } from "react";
import type { HostApi, HostFeatures } from "../data/host-api";

/**
 * What the connected Mac offers (`sync.capabilities`), read again whenever
 * that may have changed (#730): after each new connection, and when the Mac
 * says its runtime changed. Null until it has been read for `host`. The last
 * answer stands while the next is on its way, so a reconnect does not flash
 * a feature off and on.
 */
export function useHostFeatures(api: HostApi, host: string | null | undefined): HostFeatures | null {
  const [read, setRead] = useState<{ host: string; features: HostFeatures } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => api.onFeaturesChanged(() => setRevision((count) => count + 1)), [api]);
  useEffect(() => {
    if (!host) return;
    let active = true;
    // Disconnected: the next connection reads them again.
    api.features().then((features) => { if (active) setRead({ host, features }); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, host, revision]);
  return read && host && read.host === host ? read.features : null;
}
