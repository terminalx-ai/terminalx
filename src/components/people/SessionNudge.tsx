import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getAccount, useAccount } from "@/lib/account";
import { api } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { errorCode } from "@/lib/cloudTerminals";
import { getDataPrivacy, useDataPrivacy } from "@/lib/dataPrivacy";
import { phase2Ready } from "@/lib/phase2Readiness";

export interface NudgeSession {
  orgId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
}

export function SessionNudge({ session, userId }: { session: NudgeSession; userId: string }) {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const revision = status.context?.revision;
  if (!revision || !privacy.ready || privacy.enabled || !phase2Ready(status, session.orgId, "nudges")) return null;
  return <NudgeComposer key={JSON.stringify([session.orgId, session.workspaceId, session.sessionId, userId, revision])} session={session} userId={userId} revision={revision} />;
}

function NudgeComposer({ session, userId, revision }: { session: NudgeSession; userId: string; revision: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("Could you take a look at this session?");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const trimmed = text.trim();
  const valid = trimmed.length > 0 && Array.from(trimmed).length <= 240 && !/\p{Cc}/u.test(text);
  const stillCurrent = () => {
    const { status } = getAccount();
    const privacy = getDataPrivacy();
    return status.context?.revision === revision && privacy.ready && !privacy.enabled
      && phase2Ready(status, session.orgId, "nudges");
  };

  const send = async () => {
    if (!valid || sending || !stillCurrent()) return;
    setSending(true);
    setNotice(null);
    try {
      const receipt = await api.nudgeSend(session.orgId, {
        targetUserId: userId, workspaceId: session.workspaceId, sessionId: session.sessionId, text: trimmed,
      });
      if (!stillCurrent()) return;
      setEditing(false);
      setNotice(receipt.delivered ? "Nudged." : "Nudge not delivered.");
    } catch (error) {
      if (!stillCurrent()) return;
      if (errorCode(error) === "nudge_rate_limited") {
        showError("Try again in a minute", undefined, { title: "Too many nudges", key: "nudge-rate-limit", tone: "warning", copy: false });
      } else {
        setNotice("Nudge not delivered.");
      }
    } finally {
      if (stillCurrent()) setSending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-hairline pt-3">
      {editing ? (
        <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="space-y-2">
          <p className="truncate text-xs text-muted-foreground">About {session.title}</p>
          <textarea aria-label="Nudge message" className="min-h-14 w-full rounded border border-hairline bg-background p-2 text-xs" value={text} onChange={(event) => setText(event.target.value)} disabled={sending} />
          <div className="flex gap-2">
            <Button type="submit" size="xs" variant="accent" disabled={!valid || sending}>Send nudge</Button>
            <Button type="button" size="xs" variant="ghost" disabled={sending} onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : <Button size="xs" variant="secondary" onClick={() => { setNotice(null); setEditing(true); }}>Nudge</Button>}
      {notice && <p role="status" className="mt-1 text-xs text-muted-foreground">{notice}</p>}
    </div>
  );
}
