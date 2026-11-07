import { useEffect, useState } from "react";
import { api, type ProjectForge } from "./api";

// Share a project check between its sessions. Refresh while visible so signing
// in to gh or changing origin does not require restarting the app.
const checks = new Map<string, { at: number; value: Promise<ProjectForge> }>();
const RECHECK = 60_000;
export function projectForge(path: string): Promise<ProjectForge> {
  const cached = checks.get(path);
  if (cached && Date.now() - cached.at < RECHECK) return cached.value;
  const value = api.projectForge(path);
  const entry = { at: Date.now(), value };
  checks.set(path, entry);
  void value.catch(() => { if (checks.get(path) === entry) checks.delete(path); });
  return value;
}

export function useProjectForge(path: string | null): ProjectForge | undefined {
  const [read, setRead] = useState<{ path: string; forge: ProjectForge } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void projectForge(path).then((forge) => {
        if (!cancelled) setRead({ path, forge });
      }).catch(() => { if (!cancelled) setRead(null); });
    };
    refresh();
    const timer = window.setInterval(refresh, RECHECK);
    document.addEventListener("visibilitychange", refresh);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [path]);
  return read?.path === path ? read.forge : undefined;
}
