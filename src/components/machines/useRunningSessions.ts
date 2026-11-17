import { useEffect, useState } from "react";
import type { RuntimeSession, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { runtimeResources } from "@terminalx/portable/workspaceGit";
import type { CloudWorkspaceConnection } from "@/lib/api";

/** A session whose agent is working or waiting on someone: running on the machine. */
export function runningSessionCount(sessions: readonly RuntimeSession[]): number {
  return sessions.filter((session) => !session.archived && session.tabs.some((tab) => tab.status === "in_progress" || tab.status === "waiting")).length;
}

/**
 * How many sessions run on a connected machine (21.02's "3 sessions running"),
 * from its session list and then its `session.sessions` notifications. Null
 * until the list has been read, and while the machine is not connected.
 */
export function useRunningSessions(connection: CloudWorkspaceConnection | null, connected: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setCount(null);
    if (!connection || !connected) return;
    let live = true;
    const client = connection.client;
    const stop = client.onSessions((sessions) => live && setCount(runningSessionCount(sessions)));
    client
      .listSessions()
      .then((sessions) => live && setCount(runningSessionCount(sessions)))
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [connection, connected]);
  return count;
}

/** "3 sessions running", "1 session running", "no sessions running". */
export function runningText(count: number): string {
  if (count === 0) return "no sessions running";
  return `${count} session${count === 1 ? "" : "s"} running`;
}

/** Free memory on a connected machine, read once per client (`lifecycle.resources`); null where it does not report it. */
export function useFreeMemory(client: WorkspaceRpcClient | null): number | null {
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    setFree(null);
    if (!client) return;
    let live = true;
    runtimeResources(client)
      .then((resources) => live && setFree(resources?.memory?.availableBytes ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client]);
  return free;
}
