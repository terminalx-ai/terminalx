import { useEffect, useState } from "react";
import { api, type ProjectForge } from "./api";

// Share a project check between its sessions. Refresh while visible so signing
// in to gh or changing origin does not require restarting the app.
const checks = new Map<string, { expiresAt: number | null; value: Promise<ProjectForge> }>();
const RECHECK = 60_000;
const RETRY = 10_000;
export function projectForge(path: string): Promise<ProjectForge> {
  const cached = checks.get(path);
  if (cached && (cached.expiresAt === null || Date.now() < cached.expiresAt)) return cached.value;
  const value = api.projectForge(path).catch((): ProjectForge => "githubUnavailable");
  const entry: { expiresAt: number | null; value: Promise<ProjectForge> } = { expiresAt: null, value };
  checks.set(path, entry);
  // Share pending checks regardless of their duration. Start the short failure
  // cache at completion, so remounts cannot immediately repeat a timed-out call.
  void value.then((forge) => { entry.expiresAt = Date.now() + (forge === "githubUnavailable" ? RETRY : RECHECK); });
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
      }).catch(() => { if (!cancelled) setRead({ path, forge: "githubUnavailable" }); });
    };
    refresh();
    const timer = window.setInterval(refresh, RECHECK);
    document.addEventListener("visibilitychange", refresh);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [path]);
  return read?.path === path ? read.forge : undefined;
}
