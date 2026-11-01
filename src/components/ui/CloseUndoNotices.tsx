import { useState } from "react";
import { Loader2, Undo2, X } from "@/icons";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { dismissCloseUndo, holdCloseUndo, useCloseUndos, type CloseUndo } from "@/lib/closeUndo";
import { conversationTitle, useSessionStore } from "@/lib/sessions";
import { reopenClosedAgentTab } from "@/lib/tabActions";
import { tabLabel } from "@/lib/tabFront";
import { useTabState } from "@/lib/tabLayouts";

function UndoCard({ offer }: { offer: CloseUndo }) {
  const store = useSessionStore();
  const saved = useTabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only what the backend kept can come back; a tab with nothing in it was not.
  const tabs = offer.tabs.filter((tab) => saved.closed.some((closed) => closed.sessionId === offer.sessionId && closed.tab.id === tab.id));
  const session = store.sessions.find((candidate) => candidate.id === offer.sessionId);
  // While its Undo runs, and once it failed, the notice stays: a tab on its way back is no longer listed as closed,
  // and one the backend no longer has is not either, but what went wrong must still be there to read.
  if ((!tabs.length && !busy && !error) || !session || session.archived) return null;
  const named = tabs.length ? tabs : offer.tabs;
  const agentName = (harness: string) => store.harnesses.find((candidate) => candidate.id === harness)?.name ?? harness;
  const one = named.length === 1;
  const undo = () => {
    // Not withdrawn by its timer while it runs: a failure must stay to be read.
    holdCloseUndo(offer.id);
    setBusy(true);
    setError(null);
    // In the order they stood, each on its own conversation; each one back withdraws itself from this offer.
    void tabs
      .reduce<Promise<void>>((done, tab) => done.then(() => reopenClosedAgentTab(offer.sessionId, tab.id)), Promise.resolve())
      .then(() => dismissCloseUndo(offer.id))
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <aside role="status" aria-busy={busy} data-testid="close-undo" className="pointer-events-auto rounded-xl bg-popover glass p-3 text-sm text-popover-foreground shadow-surface hairline animate-fade-in">
      <div className="flex items-start gap-2.5">
        <AgentMark id={named[0].harness} className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{one ? `Closed “${tabLabel(named[0], agentName)}”` : `Closed ${named.length} tabs`}</div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            {one
              ? `The last tab running in ${conversationTitle(session)}: closing it stopped its agent. Undo reopens it on the same conversation.`
              : `The last tabs running in ${conversationTitle(session)}: closing them stopped their agents. Undo reopens them on the same conversations.`}
          </div>
          {error ? (
            <div role="alert" className="mt-1 text-xs text-destructive">
              {error}
            </div>
          ) : null}
          {tabs.length || busy ? (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={undo}>
                {busy ? <Loader2 aria-hidden className="animate-spin" /> : <Undo2 aria-hidden />} Undo
              </Button>
            </div>
          ) : null}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => dismissCloseUndo(offer.id)}>
          <X />
        </Button>
      </div>
    </aside>
  );
}

/**
 * Undo for closing a session's last running tab (#721), bottom right: it
 * says the agent stopped, and Undo reopens the tab on the same conversation.
 * Mounted once by each window's shell.
 */
export function CloseUndoNotices() {
  const offers = useCloseUndos();
  if (!offers.length) return null;
  return (
    <div className="pointer-events-none flex shrink-0 flex-col gap-2">
      {offers.map((offer) => (
        <UndoCard key={offer.id} offer={offer} />
      ))}
    </div>
  );
}
