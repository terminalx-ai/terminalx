import { revealInFileManager } from "@/lib/platform";
import { openPairPhone } from "@/lib/pairing";
import { copyText } from "@/lib/clipboard";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { Archive, CircleDot, Copy, Ellipsis, FolderOpen, FolderSync, GitBranch, Link, Pencil, SessionContinue, Smartphone, SquareTerminal, Target, Unplug, UserPlus } from "@/icons";
import { message } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuShortcut } from "@/components/ui/menu";
import { RenameBranchDialog } from "@/components/layout/RenameBranchDialog";
import { api, errorMessage } from "@/lib/api";
import { readChangesChoice } from "@/lib/changesScope";
import { useDataPrivacy, PRIVACY_MESSAGE } from "@/lib/dataPrivacy";
import { openLinkIssue, openRenameSession } from "@/lib/dialogs";
import { useShortcut, useShortcutKeycaps } from "@/lib/hotkeys";
import { copyShareLink, openSessionShare } from "@/lib/localSharing";
import { showPanelTab } from "@/lib/panelTab";
import { isQuickChat } from "@/lib/quickChats";
import { archiveSession, unlinkSessionIssue, useSessionStore } from "@/lib/sessions";
import type { ShortcutId } from "@/lib/shortcuts";
import type { SessionEntry } from "@/types/session";
import { RepoMirrorButton, useRepoMirror } from "./RepoMirrorControl";

/** The tab's chat or terminal switch, as the header has it. */
export interface SessionMenuTerminalView {
  available: boolean;
  /** What the switch does now: "Open in terminal view", or back to the chat from the terminal. */
  label: string;
  toggle: () => void;
}

function failed(title: string) {
  return (error: unknown) => void message(errorMessage(error), { title, kind: "error" }).catch(() => undefined);
}

/**
 * The title bar's '…' menu (PRO-397, design 02.12): what can be done to the
 * session and its branch. Each row is an action the app has elsewhere too
 * (the sidebar's menus, the Changes panel, the tab's view switch); a row
 * with a shortcut shows the keys the keymap has for it now.
 */
export function SessionMenu({ session, branch, cloud = false, terminalView, onContinue }: {
  session: SessionEntry;
  /** The branch checked out in the session's folder, or null when detached. */
  branch: string | null;
  /** A cloud session has no branch, share link or repo mirror on this Mac. */
  cloud?: boolean;
  terminalView: SessionMenuTerminalView | null;
  onContinue: (() => void) | null;
}) {
  // The crumb has no room for another control: starting a mirror is a row
  // here, and a running one shows in the title bar, where it can be stopped.
  const mirror = useRepoMirror(session);
  const keys = useShortcutKeycaps();
  const privacy = useDataPrivacy();
  const store = useSessionStore();
  const [open, setOpen] = useState(false);
  const [renamingBranch, setRenamingBranch] = useState(false);
  // What Changes compares against: the target chosen there, else the repository's default branch, as the backend picks it.
  const chosen = readChangesChoice(`local:${session.cwd}`).target;
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const quick = isQuickChat(session);
  const project = store.projects.find((entry) => entry.path === session.projectPath);
  const mainBranch = (store.workspaces[session.projectPath] ?? []).find((workspace) => workspace.isMain)?.branch ?? null;
  const branchRenamable = !cloud && !quick && !!branch && project?.kind !== "folder" && !session.worktreeRemoved;
  const shortcut = (id: ShortcutId) => {
    const caps = keys(id);
    return caps.length ? <span data-shortcut={id} className="contents"><MenuShortcut keys={caps} /></span> : null;
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !cloud && !chosen) void api.workStatus(session.cwd).then((status) => setDefaultBranch(status.defaultBranch)).catch(() => undefined);
  };
  const target = chosen ?? defaultBranch;
  const linkIssue = () => openLinkIssue(session.id);
  const copyLink = () => void copyShareLink(session.id).catch(failed("Could not copy a link to the session"));
  useShortcut("session.linkIssue", linkIssue, { enabled: !quick && !session.issue });
  useShortcut("session.copyLink", copyLink, { enabled: !cloud && !privacy.enabled });
  return (
    <>
      {mirror.on && <RepoMirrorButton mirror={mirror} />}
      {mirror.dialog}
      {renamingBranch && branch && (
        <RenameBranchDialog
          projectPath={session.projectPath}
          branch={branch}
          label={project?.branchLabels?.[branch]}
          canRenameBranch={branch !== mainBranch}
          onClose={() => setRenamingBranch(false)}
        />
      )}
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <WithTooltip label="Session actions">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Session actions" className="ml-0.5 shrink-0 text-faint hover:text-foreground" data-testid="session-menu-trigger">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
        </WithTooltip>
        <DropdownMenuContent align="start" className="min-w-[16rem] max-w-[22rem]" data-testid="session-menu">
          {!cloud && !quick && (
            <>
              <DropdownMenuItem data-row="target" onSelect={() => showPanelTab("changes")} title="Changes compares against this branch. Choose another in the Changes panel.">
                <Target /> Target branch
                <span className="ml-auto min-w-0 truncate pl-4 font-mono text-[12px] text-muted-foreground" data-testid="session-menu-target">{target ?? "automatic"}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem data-row="rename-session" onSelect={() => openRenameSession(session.id)}>
            <Pencil /> Rename session…
          </DropdownMenuItem>
          {branchRenamable && (
            <DropdownMenuItem data-row="rename-branch" onSelect={() => setRenamingBranch(true)}>
              <GitBranch /> Rename branch…
            </DropdownMenuItem>
          )}
          {!quick && (session.issue ? (
            <DropdownMenuItem data-row="link-issue" onSelect={() => void unlinkSessionIssue(session.id).catch(failed("Could not unlink the issue"))}>
              <Unplug /> Unlink {session.issue.identifier}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem data-row="link-issue" onSelect={linkIssue}>
              <CircleDot /> Link issue
              {shortcut("session.linkIssue")}
            </DropdownMenuItem>
          ))}
          {!cloud && (
            <>
              <DropdownMenuItem data-row="copy-link" disabled={privacy.enabled} title={privacy.enabled ? PRIVACY_MESSAGE : undefined} onSelect={copyLink}>
                <Link /> Copy link
                {shortcut("session.copyLink")}
              </DropdownMenuItem>
              <DropdownMenuItem data-row="share" disabled={privacy.enabled} title={privacy.enabled ? PRIVACY_MESSAGE : undefined} onSelect={() => openSessionShare(session.id)}>
                <UserPlus /> Share session…
              </DropdownMenuItem>
            </>
          )}
          {/* A running mirror is in the title bar, where it is stopped; the menu only starts one. */}
          {!cloud && mirror.eligible && !mirror.on && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-row="mirror" className="items-start" onSelect={mirror.show}>
                <FolderSync className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>Mirror into repo root</span>
                  <span className="text-[11px] text-muted-foreground">Test these changes from the main checkout</span>
                </span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          {branch && <DropdownMenuItem onSelect={() => void copyText(branch).catch(failed("Could not copy the branch name"))}><Copy /> Copy branch name</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => void revealItemInDir(session.cwd).catch(failed("Could not reveal the workspace"))}><FolderOpen /> {revealInFileManager}</DropdownMenuItem>
          {onContinue && <DropdownMenuItem onSelect={onContinue}><SessionContinue /> Continue in New Session…</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => openPairPhone()}><Smartphone /> Pair a phone…</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-row="terminal-view" disabled={!terminalView?.available} onSelect={() => terminalView?.toggle()}>
            <SquareTerminal /> {terminalView?.label ?? "Open in terminal view"}
            {shortcut("session.toggleTerminalView")}
          </DropdownMenuItem>
          {!cloud && (
            <DropdownMenuItem data-row="archive" onSelect={() => void archiveSession(session.id, true).catch(failed("Could not archive the session"))}>
              <Archive /> Archive session
              {shortcut("session.archive")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
