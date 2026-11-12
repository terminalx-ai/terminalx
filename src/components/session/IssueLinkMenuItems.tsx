import { CircleDot, EyeOff, GitPullRequest, Unplug } from "@/icons";
import { message } from "@tauri-apps/plugin-dialog";
import { ContextMenuCheckboxItem, ContextMenuItem, DropdownMenuCheckboxItem, DropdownMenuItem } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api";
import { openLinkIssue, openLinkPr } from "@/lib/dialogs";
import { linkText } from "@/lib/issueWork";
import { isQuickChat } from "@/lib/quickChats";
import { setSessionWorkPrivate, unlinkSessionIssue } from "@/lib/sessions";
import type { SessionEntry } from "@/types/session";

function failed(title: string) {
  return (error: unknown) => void message(errorMessage(error), { title, kind: "error" }).catch(() => undefined);
}

function unlink(session: SessionEntry) {
  void unlinkSessionIssue(session.id).catch(failed("Could not unlink the issue"));
}

function setPrivate(session: SessionEntry, isPrivate: boolean) {
  void setSessionWorkPrivate(session.id, isPrivate).catch(failed("Could not change what this session shares"));
}

/** What a menu says of the session's issue: "Unlink #441 (linked from its branch name)". */
function unlinkLabel(session: SessionEntry): string {
  const link = session.issueWork?.link;
  return `Unlink ${session.issue?.identifier ?? "issue"}${link && link !== "manual" ? ` (${linkText(link).toLowerCase()})` : ""}`;
}

/** A session in a Git checkout on this Mac can show another branch's pull request (PRO-294). */
function canLinkPr(session: SessionEntry): boolean {
  return !session.id.startsWith("cloud:") && !!session.cwd && !!session.branch && !session.worktreeRemoved;
}

const SHARE_HINT = "Its work status never leaves this Mac: your other machines and your team do not see it.";

/**
 * A session's issue link and what it shares (#441): "Link to issue…" or
 * "Unlink", "Link pull request…" (PRO-294), and "Don't share this session". Nothing for a quick chat, which
 * has no project, so a menu can include it unconditionally.
 */
export function IssueLinkMenuItems({ session }: { session: SessionEntry }) {
  if (isQuickChat(session)) return null;
  return (
    <>
      {session.issue ? (
        <DropdownMenuItem onSelect={() => unlink(session)}>
          <Unplug /> {unlinkLabel(session)}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => openLinkIssue(session.id)}>
          <CircleDot /> Link to issue…
        </DropdownMenuItem>
      )}
      {canLinkPr(session) && (
        <DropdownMenuItem onSelect={() => openLinkPr(session.id)}>
          <GitPullRequest /> Link pull request…
        </DropdownMenuItem>
      )}
      <DropdownMenuCheckboxItem checked={!!session.issueWork?.private} onCheckedChange={(on) => setPrivate(session, on === true)} title={SHARE_HINT}>
        <EyeOff /> Don’t share this session
      </DropdownMenuCheckboxItem>
    </>
  );
}

/** The same, for a right-click menu. */
export function IssueLinkContextItems({ session, disabled = false }: { session: SessionEntry; disabled?: boolean }) {
  if (isQuickChat(session)) return null;
  return (
    <>
      {session.issue ? (
        <ContextMenuItem disabled={disabled} onSelect={() => unlink(session)}>
          <Unplug /> {unlinkLabel(session)}
        </ContextMenuItem>
      ) : (
        <ContextMenuItem disabled={disabled} onSelect={() => openLinkIssue(session.id)}>
          <CircleDot /> Link to issue…
        </ContextMenuItem>
      )}
      {canLinkPr(session) && (
        <ContextMenuItem disabled={disabled} onSelect={() => openLinkPr(session.id)}>
          <GitPullRequest /> Link pull request…
        </ContextMenuItem>
      )}
      <ContextMenuCheckboxItem disabled={disabled} checked={!!session.issueWork?.private} onCheckedChange={(on) => setPrivate(session, on === true)} title={SHARE_HINT}>
        <EyeOff /> Don’t share this session
      </ContextMenuCheckboxItem>
    </>
  );
}
