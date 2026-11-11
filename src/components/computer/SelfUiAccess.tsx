import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";

/** The person can revoke access without finding the agent's conversation. */
export function SelfUiAccess() {
  const [error, setError] = useState(false);
  const [grants, setGrants] = useState<{ id: string; expiresAt: number }[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => void invoke<typeof grants>("self_ui_grants").then((grants) => { if (active && Array.isArray(grants)) setGrants(grants); }).catch(() => {});
    const stop = listen("self-ui-grants-changed", refresh).catch(() => () => {});
    refresh();
    return () => { active = false; void stop.then((stop) => stop()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!grants.length) return;
    const timer = setTimeout(() => setGrants((current) => current.filter((grant) => grant.expiresAt > Date.now())), Math.max(0, Math.min(...grants.map((grant) => grant.expiresAt)) - Date.now()));
    return () => clearTimeout(timer);
  }, [grants]);
  if (!grants.length) return null;
  return <div role="status" className="flex items-center justify-between gap-3 border-b border-border bg-well px-4 py-2 text-xs">
    <span>{error ? "UI access could not be revoked. Try again; existing access still expires automatically." : "An agent has temporary access to approved session controls."}</span>
    <Button size="xs" onClick={() => { setError(false); void Promise.all(grants.map(({ id }) => invoke("self_ui_revoke", { id }))).catch(() => setError(true)); }}>Revoke agent UI access</Button>
  </div>;
}
