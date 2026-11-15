import { useEffect, useMemo, useState } from "react";
import { useApp } from "./AppProvider";
import { machineList } from "./machines";

/** The phone's machines as the screens show them (#987), with "last seen" kept current. */
export function useMachines() {
  const app = useApp();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const { hosts, accountHosts, accountMachinePrefs, activeHost, connectionStage, connectionAttempt } = app;
  return useMemo(() => machineList({
    hosts,
    accountHosts: accountHosts ?? [],
    prefs: accountMachinePrefs ?? {},
    activeHostId: activeHost?.id ?? null,
    connectionStage,
    connectionAttempt,
    now,
  }), [hosts, accountHosts, accountMachinePrefs, activeHost?.id, connectionStage, connectionAttempt, now]);
}
