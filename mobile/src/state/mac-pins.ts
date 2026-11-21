import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import type { ControlResult } from "@mobile/data/host-api";
import type { ChatRow } from "@mobile/data/session-list";
import type { RowAction } from "@mobile/ui/row-actions";
import { useApp } from "./AppProvider";

/**
 * What the connected Mac pins (#1403): whether it pins and unpins from the
 * phone (`pin`), the cloud projects it pinned, and the Pin and Unpin actions
 * for a row. The cloud pins are read again whenever the session list is,
 * which the Mac asks for when they change. A Mac that does not name `pin`
 * offers no action and no cloud pins: its Pinned section is what it pinned.
 *
 * A row moves only once the Mac has confirmed: the list is read again then.
 * A refusal (a phone that may only watch, a session that has gone) is said
 * in an alert, in the Mac's words.
 */
export function useMacPins() {
  const app = useApp();
  const { api, sessions, refreshSessions } = app;
  const connected = app.connectionStage === "connected";
  const host = app.activeHost?.id ?? null;
  const [state, setState] = useState<{ host: string | null; supported: boolean; cloud: Record<string, string[]> }>({ host, supported: false, cloud: {} });

  const read = useCallback(async (live: () => boolean) => {
    const supported = await api.pins();
    const cloud = supported ? await api.cloudPins() : {};
    // Null: the Mac would not say just now; what was shown stays.
    if (live()) setState((current) => ({ host, supported, cloud: cloud ?? (current.host === host ? current.cloud : {}) }));
  }, [api, host]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const live = () => active;
    // A connection that fails meanwhile is shown as the connection's state; the next list read tries again.
    const again = () => { void read(live).catch(() => undefined); };
    again();
    const off = api.onFeaturesChanged(again);
    return () => { active = false; off(); };
  }, [api, connected, read, sessions]);

  // Another Mac's pins are never shown for this one.
  const current = state.host === host ? state : { host, supported: false, cloud: {} };
  const offered = current.supported && connected;

  const act = useCallback(async (change: () => Promise<ControlResult>, failed: string) => {
    let result: ControlResult;
    try {
      result = await change();
    } catch (cause) {
      Alert.alert(failed, cause instanceof Error ? cause.message : "The Mac could not be reached. Try again.");
      return;
    }
    if (!result.done) { Alert.alert(failed, result.message); return; }
    await refreshSessions();
    await read(() => true).catch(() => undefined);
  }, [read, refreshSessions]);

  const sessionActions = useCallback((row: ChatRow): RowAction[] => offered ? [{
    name: row.pinned ? "unpin" : "pin",
    label: row.pinned ? "Unpin" : "Pin",
    run: () => { void act(() => api.setPinned(row.session.id, !row.pinned), row.pinned ? `Couldn't unpin “${row.title}”` : `Couldn't pin “${row.title}”`); },
  }] : [], [act, api, offered]);

  const cloudActions = useCallback((orgId: string, identity: string, title: string): RowAction[] => {
    if (!offered) return [];
    const pinned = current.cloud[orgId]?.includes(identity) ?? false;
    return [{
      name: pinned ? "unpin" : "pin",
      label: pinned ? "Unpin project" : "Pin project",
      run: () => { void act(() => api.setCloudPinned(orgId, identity, !pinned), pinned ? `Couldn't unpin “${title}”` : `Couldn't pin “${title}”`); },
    }];
  }, [act, api, current.cloud, offered]);

  return { supported: current.supported, cloud: current.cloud, sessionActions, cloudActions };
}
