import { useMemo, useRef } from "react";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { terminalViewOf } from "@/lib/sessionBackend";
import { remoteRow, type RemoteTabs, type TabRow } from "@/lib/sessionTabs";
import { useTabState } from "@/lib/tabLayouts";
import { toggleTabView } from "@/lib/tabViews";
import { selectSessionTab } from "@/lib/terminal";
import type { SessionEntry } from "@/types/session";

/**
 * A cloud session's row of tabs (#1325): the runtime's agent tabs and the
 * shells it opened for the session, in the order this viewer arranged them.
 * Showing a tab selects it in the session (as the sidebar does), closing one
 * closes it on the runtime, and the order, pins and panes stay on this
 * computer (`remoteLayoutKey`), so each person in a shared workspace keeps
 * their own. Null when there is no row to draw (`enabled` false, or a local
 * session).
 */
export function useRemoteTabRow(session: SessionEntry, cloud: CloudSessionModel | undefined, enabled: boolean): TabRow | null {
  const saved = useTabState();
  const latest = useRef<TabRow | null>(null);
  const backend = cloud?.backend;
  const terminals = cloud?.terminals;
  const closeTab = cloud?.closeTab;
  const row = useMemo(() => {
    if (!enabled || !backend || !terminals || !closeTab) return null;
    const place = { remote: true, toTerminal: backend.toTerminal };
    const remote: RemoteTabs = {
      open: (tab) => selectSessionTab(session.id, { kind: tab.kind, id: tab.id }),
      close: (tab) => closeTab({ kind: tab.kind, id: tab.id }),
      current: () => latest.current!,
      terminalView: (tab) => (terminalViewOf(backend, tab).available ? () => void toggleTabView(session, tab, place) : null),
    };
    return remoteRow(session, terminals, saved, remote);
  }, [enabled, backend, terminals, closeTab, session, saved]);
  latest.current = row;
  return row;
}
