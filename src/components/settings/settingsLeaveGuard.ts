import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

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

/** The shell owns the boundary so shortcuts and incoming settings links use the same guard. */
export function useSettingsLeaveBoundary() {
  const guards = useRef(new Set<() => boolean>()).current;
  const [warning, setWarning] = useState(false);
  const canLeave = useCallback(() => {
    const blocked = [...guards].some((guard) => guard());
    setWarning(blocked);
    return !blocked;
  }, [guards]);
  return { guards, warning, canLeave };
}

export const SettingsLeaveBoundaryContext = createContext<ReturnType<typeof useSettingsLeaveBoundary> | null>(null);
