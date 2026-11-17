import { createContext, useContext, useEffect, useRef } from "react";

/** Mounted editors can keep Settings open until their drafts have been saved. */
export const SettingsLeaveGuardContext = createContext<Set<() => boolean> | null>(null);

export function useSettingsLeaveGuard(blocked: boolean) {
  const guards = useContext(SettingsLeaveGuardContext);
  const latest = useRef(blocked);
  latest.current = blocked;
  useEffect(() => {
    const guard = () => latest.current;
    guards?.add(guard);
    return () => { guards?.delete(guard); };
  }, [guards]);
}
