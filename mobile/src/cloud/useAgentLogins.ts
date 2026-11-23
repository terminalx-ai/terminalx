import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { CloudApi, CloudCredential } from "./api";
import { refusalOf } from "./logins";

/**
 * An organization's agent logins as the service lists them, read each time a
 * page that shows them comes to the front (so the list is right after a login
 * was saved on the page above it).
 *
 * What was read last is kept for as long as the signed-in account's client
 * lives, so the next page opens on it instead of a spinner. It holds no
 * secret: the service describes a login by fingerprint only.
 */
export type AgentLogins =
  | { status: "loading" }
  | { status: "ready"; credentials: readonly CloudCredential[] }
  /** The service keeps this list for owners and admins. */
  | { status: "member" }
  | { status: "failed" };

type LoginsApi = Pick<CloudApi, "credentials">;
const read = new WeakMap<object, Map<string, readonly CloudCredential[]>>();
const kept = (api: LoginsApi | null, orgId: string) => (api ? read.get(api)?.get(orgId) ?? null : null);
function keep(api: LoginsApi, orgId: string, credentials: readonly CloudCredential[]) {
  const lists = read.get(api) ?? new Map<string, readonly CloudCredential[]>();
  read.set(api, lists.set(orgId, credentials));
}

export function useAgentLogins(api: LoginsApi | null, orgId: string): { logins: AgentLogins; reload(): Promise<void>; put(credential: CloudCredential): void; drop(provider: string): void } {
  const initial = (): AgentLogins => {
    const credentials = kept(api, orgId);
    return credentials ? { status: "ready", credentials } : { status: "loading" };
  };
  const [logins, setLogins] = useState<AgentLogins>(initial);
  const turn = useRef(0);
  useEffect(() => () => { turn.current += 1; }, []);

  const reload = useCallback(async () => {
    if (!api) return;
    const mine = ++turn.current;
    // What is shown stays while it is read again; only a first read shows as loading.
    setLogins((current) => (current.status === "ready" ? current : { status: "loading" }));
    try {
      const credentials = await api.credentials(orgId);
      keep(api, orgId, credentials);
      if (turn.current === mine) setLogins({ status: "ready", credentials });
    } catch (error) {
      if (turn.current !== mine) return;
      if (refusalOf(error) === "admin-required") {
        read.get(api)?.delete(orgId);
        setLogins({ status: "member" });
      } else setLogins((current) => (current.status === "ready" ? current : { status: "failed" }));
    }
  }, [api, orgId]);
  useFocusEffect(useCallback(() => { void reload(); }, [reload]));

  /** The service's answer to a save or a revoke takes the login's place at once. */
  const put = useCallback((credential: CloudCredential) => {
    if (!api) return;
    const next = [...(kept(api, orgId) ?? []).filter((entry) => entry.provider !== credential.provider), credential];
    keep(api, orgId, next);
    turn.current += 1;
    setLogins({ status: "ready", credentials: next });
  }, [api, orgId]);

  const drop = useCallback((provider: string) => {
    if (!api) return;
    const next = (kept(api, orgId) ?? []).filter((entry) => entry.provider !== provider);
    keep(api, orgId, next);
    turn.current += 1;
    setLogins({ status: "ready", credentials: next });
  }, [api, orgId]);

  return { logins, reload, put, drop };
}
