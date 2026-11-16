import { useEffect, useMemo, useState } from "react";
import { useApp } from "./AppProvider";
import { useConnectionState } from "./connection-view";
import { machineList } from "./machines";

/** The phone's machines as the screens show them (#987), with "last seen" kept current. */
export function useMachines() {
  const app = useApp();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const { hosts, accountHosts, accountMachinePrefs, activeHost } = app;
  // The same derived state as the Sessions header and the session subtitle, so the menu and VoiceOver say the same words.
  const connection = useConnectionState(app);
  return useMemo(() => machineList({
    hosts,
    accountHosts: accountHosts ?? [],
    prefs: accountMachinePrefs ?? {},
    activeHostId: activeHost?.id ?? null,
    connection,
    now,
  }), [hosts, accountHosts, accountMachinePrefs, activeHost?.id, connection, now]);
}
