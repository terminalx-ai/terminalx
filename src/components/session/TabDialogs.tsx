import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogScrollArea, DialogTitle } from "@/components/ui/dialog";
import { errorMessage, pty } from "@/lib/api";
import { closeCloseTabs, closeRenameTab, useDialogs, type TabRequest } from "@/lib/dialogs";
import { useSessionStore } from "@/lib/sessions";
import { hasOwnTitle, isShellPeer, peerLabel, peerPaneId, peerShell, useTabRow, type PeerTab } from "@/lib/sessionTabs";
import { BULK_CLOSE_LABEL, busyTabs, closeTabs, planBulkClose, renamePeer, type BulkClose } from "@/lib/tabActions";
import { useVisibleSessionTab } from "@/lib/visibleTab";
import type { SessionEntry } from "@/types/session";
import { TabIcon } from "./WorkspaceTabStrip";

const count = (n: number) => `${n} tab${n === 1 ? "" : "s"}`;

/**
 * Dialogs about a workspace's tabs that a menu or a shortcut opens: renaming
 * one, and the confirmation before several are closed at once.
 */
export function TabDialogs() {
  const dialogs = useDialogs();
  const sessions = useSessionStore().sessions;
  const renaming = sessions.find((session) => session.id === dialogs.renameTab?.sessionId);
  const closing = sessions.find((session) => session.id === dialogs.closeTabs?.sessionId);
  return (
    <>
      {renaming && dialogs.renameTab && <RenameTabDialog key={dialogs.renameTab.tab} session={renaming} request={dialogs.renameTab} onClose={closeRenameTab} />}
      {closing && dialogs.closeTabs && <CloseTabsDialog session={closing} request={dialogs.closeTabs} onClose={closeCloseTabs} />}
    </>
  );
}

function useHarnessName() {
  const harnesses = useSessionStore().harnesses;
  return (id: string) => harnesses.find((harness) => harness.id === id)?.name;
}

function RenameTabDialog({ session, request, onClose }: { session: SessionEntry; request: TabRequest; onClose: () => void }) {
  const row = useTabRow(session);
  const harnessName = useHarnessName();
  const tab = row.tabs.find((candidate) => candidate.key === request.tab);
  const current = tab ? peerLabel(tab, row.layout, harnessName) : "";
  const [title, setTitle] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.select();
  }, []);
  // The tab was closed while its name was being typed.
  useEffect(() => {
    if (!tab) onClose();
  }, [tab, onClose]);
  if (!tab) return null;
  const wanted = title.trim();
  const save = async () => {
    if (!wanted || saving) return;
    // The name it already goes by, kept as it is: nothing becomes the reader's own title by pressing Return.
    if (wanted === current && !hasOwnTitle(tab, row.layout)) return onClose();
    setSaving(true);
    setError(null);
    try {
      await renamePeer(row, tab, wanted);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[26rem]" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Rename tab</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">Your own title for this tab. “Reset title” in its menu takes it away again.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            ref={input}
            aria-label="Tab title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-border bg-well px-2.5 py-1.5 text-sm outline-none focus:border-ring"
          />
          {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!wanted || saving}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asked before every bulk close. It says how many tabs go; when any of them
 * has an agent working or waiting, a shell running a command or a draft not
 * sent, it lists those and offers to close only the rest. Pinned tabs stay
 * open unless the reader includes them.
 */
function CloseTabsDialog({ session, request, onClose }: { session: SessionEntry; request: TabRequest & { action: BulkClose }; onClose: () => void }) {
  const row = useTabRow(session);
  const harnessName = useHarnessName();
  const selected = useVisibleSessionTab(session.id);
  const [withPinned, setWithPinned] = useState(false);
  const [working, setWorking] = useState(false);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const anchor = row.tabs.find((tab) => tab.key === request.tab) ?? null;
  const plan = useMemo(() => planBulkClose(request.action, row.tabs, anchor), [request.action, row.tabs, anchor]);
  const closing = useMemo(() => {
    if (!withPinned) return plan.targets;
    const reached = new Set([...plan.targets, ...plan.pinned].map((tab) => tab.key));
    return row.tabs.filter((tab) => reached.has(tab.key));
  }, [plan, row.tabs, withPinned]);
  // Which shells are in the middle of a command is the backend's to say.
  const shells = closing.filter((tab) => isShellPeer(tab) && !peerShell(tab)?.exited).map((tab) => peerPaneId(tab)).join("\n");
  useEffect(() => {
    if (!shells) return setRunning(new Set());
    let live = true;
    void pty.busy(shells.split("\n")).then(
      (ids) => live && setRunning(new Set(ids)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [shells]);
  const busy = busyTabs(closing, running);
  const busyKeys = new Set(busy.map((entry) => entry.tab.key));
  const idle = closing.filter((tab) => !busyKeys.has(tab.key));
  const several = row.sessions.length > 1;
  const sessionOf = (tab: PeerTab) => (several && tab.sessionId ? row.sessions.find((candidate) => candidate.id === tab.sessionId)?.title : undefined);
  const close = async (tabs: PeerTab[]) => {
    if (working) return;
    setWorking(true);
    try {
      await closeTabs(row, tabs, selected);
    } finally {
      onClose();
    }
  };
  const pinned = plan.pinned.length;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[30rem]" layout="pinned" onEscapeKeyDown={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{closing.length ? `Close ${count(closing.length)}?` : BULK_CLOSE_LABEL[request.action]}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground" data-testid="close-tabs-summary">
            {closing.length
              ? `“${BULK_CLOSE_LABEL[request.action]}” closes ${count(closing.length)} of this workspace${several ? ", across its sessions" : ""}. Conversations are kept and can be reopened; nothing is deleted from disk.`
              : pinned
                ? `Only pinned tabs are in range, and pinned tabs are left open.`
                : "There are no tabs to close."}
          </DialogDescription>
        </DialogHeader>
        {busy.length > 0 && (
          <>
            <p className="mb-1.5 shrink-0 text-xs font-medium text-warning">{busy.length === 1 ? "One of them has something going on:" : `${busy.length} of them have something going on:`}</p>
            <DialogScrollArea aria-label="Tabs with something going on" className="max-h-56 min-h-8">
              <ul className="flex flex-col gap-0.5" data-testid="close-tabs-busy">
                {busy.map(({ tab, reasons }) => (
                  <li key={tab.key} className="flex min-w-0 items-center gap-2 rounded-md bg-veil-card px-2 py-1 text-xs">
                    <TabIcon tab={tab} />
                    <span className="min-w-0 flex-1 truncate">
                      {peerLabel(tab, row.layout, harnessName)}
                      {sessionOf(tab) ? <span className="text-faint"> · {sessionOf(tab)}</span> : null}
                    </span>
                    <span className="shrink-0 text-warning">{reasons.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </DialogScrollArea>
          </>
        )}
        {pinned > 0 && (
          <label className="mt-3 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={withPinned} onChange={(event) => setWithPinned(event.target.checked)} />
            Also close {pinned === 1 ? "the pinned tab" : `the ${pinned} pinned tabs`} in range
          </label>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          {busy.length > 0 && idle.length > 0 && (
            <Button type="button" variant="secondary" disabled={working} onClick={() => void close(idle)}>
              Close idle ones only ({idle.length})
            </Button>
          )}
          <Button type="button" variant={busy.length ? "destructive" : "default"} disabled={working || !closing.length} onClick={() => void close(closing)}>
            Close {count(closing.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
