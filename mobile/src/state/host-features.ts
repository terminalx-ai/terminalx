import { useEffect, useState } from "react";
import type { HostApi, HostFeatures } from "../data/host-api";
import { readSaved, writeSaved } from "../data/transcript-cache";

/**
 * What the connected Mac offers (`sync.capabilities`), read again whenever
 * that may have changed (#730): after each new connection, and when the Mac
 * says its runtime changed. The last answer stands while the next is on its
 * way, so a reconnect does not flash a feature off and on. Until the phone
 * has connected, what this Mac offered last time stands in, so a screen is
 * laid out the same before and after the connection comes up (#983). Null
 * until either is known for `host`.
 */
export function useHostFeatures(api: HostApi, host: string | null | undefined): HostFeatures | null {
  const [read, setRead] = useState<{ host: string; features: HostFeatures; live: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => api.onFeaturesChanged(() => setRevision((count) => count + 1)), [api]);
  useEffect(() => {
    if (!host) return;
    let active = true;
    void readSaved(host, "features", isFeatures).then((saved) => {
      if (active && saved) setRead((current) => current?.host === host && current.live ? current : { host, features: saved, live: false });
    });
    return () => { active = false; };
  }, [host]);
  useEffect(() => {
    if (!host) return;
    let active = true;
    // Disconnected: the next connection reads them again.
    api.features().then((features) => {
      if (!active) return;
      setRead({ host, features, live: true });
      void writeSaved(host, "features", features);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, host, revision]);
  return read && host && read.host === host ? read.features : null;
}

function isFeatures(value: unknown): value is HostFeatures {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "number");
}
