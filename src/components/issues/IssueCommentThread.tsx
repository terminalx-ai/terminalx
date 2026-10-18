import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Ellipsis, Loader2, Pencil, Trash2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Markdown } from "@/components/chat/Markdown";
import { MarkdownEditor } from "@/components/issues/MarkdownEditor";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { readAllComments, type IssueThread } from "@/lib/issueComments";
import { issueOps, type IssueComment, type IssueProvider, type IssueUser } from "@/lib/issueOps";
import { relativeTime } from "@/lib/time";

/** Comments shown at first, and added by each "Show earlier comments". */
export const THREAD_WINDOW = 30;

function exactTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function UserAvatar({ user, className }: { user?: IssueUser | null; className?: string }) {
  const [broken, setBroken] = useState(false);
  const name = user?.name || user?.login || "?";
  if (user?.avatarUrl && !broken) {
    return <img src={user.avatarUrl} alt="" onError={() => setBroken(true)} className={cn("size-6 shrink-0 rounded-full bg-veil-raised object-cover", className)} />;
  }
  return (
    <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center rounded-full bg-veil-strong text-[11px] font-medium uppercase text-muted-foreground", className)}>
      {name.slice(0, 1)}
    </span>
  );
}

/**
 * One comment: who wrote it and when, its Markdown, and for the viewer's own
 * comments a "…" menu to edit it in place or delete it after a confirmation.
 * `onEdit` and `onDelete` resolve once the provider took the change and
 * reject with what to show when it did not.
 */
export function IssueCommentItem({
  comment,
  onEdit,
  onDelete,
}: {
  comment: IssueComment;
  onEdit?: (body: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const author = comment.author?.name || comment.author?.login || "Someone";
  const canEdit = comment.viewerCanEdit && !!onEdit;
  const canDelete = comment.viewerCanDelete && !!onDelete;

  const run = async (action: () => Promise<void>, after: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (draft == null || !draft.trim() || !onEdit) return;
    if (draft === comment.body) return setDraft(null);
    void run(() => onEdit(draft), () => setDraft(null));
  };

  return (
    <li className="flex min-w-0 gap-2.5 py-2.5" aria-label={`Comment by ${author}`} data-comment-id={comment.id}>
      <UserAvatar user={comment.author} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate font-medium text-foreground">{author}</span>
          <time dateTime={comment.createdAt} title={exactTime(comment.createdAt)} className="shrink-0">
            {relativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && (
            <span className="shrink-0 text-faint" title={`Edited ${exactTime(comment.editedAt)}`}>
              · edited
            </span>
          )}
          {busy && <Loader2 className="size-3 shrink-0 animate-spin" />}
          {(canEdit || canDelete) && draft == null && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="-my-1 ml-auto shrink-0" aria-label={`Actions for comment by ${author}`} disabled={busy}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setConfirming(false);
                      setError(null);
                      setDraft(comment.body);
                    }}
                  >
                    <Pencil /> Edit
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem className="text-destructive" onSelect={() => setConfirming(true)}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {draft != null ? (
          <MarkdownEditor
            className="mt-1.5"
            label="Edit comment"
            value={draft}
            onChange={setDraft}
            autoFocus
            disabled={busy}
            onSubmit={save}
            onCancel={() => !busy && setDraft(null)}
          >
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="accent" size="xs" disabled={busy || !draft.trim()} onClick={save}>
              Save
            </Button>
          </MarkdownEditor>
        ) : comment.body.trim() ? (
          <Markdown text={comment.body} className="mt-0.5 text-[13px]" />
        ) : (
          <div className="mt-0.5 text-[13px] text-faint">No text.</div>
        )}
        {confirming && (
          <div className="mt-2 rounded-md border border-destructive/25 bg-destructive/5 p-2" role="group" aria-label="Confirm delete">
            <p className="text-[11px] leading-relaxed text-muted-foreground">Delete this comment? It is removed from the issue for everyone.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="destructive" size="xs" disabled={busy} onClick={() => onDelete && void run(onDelete, () => setConfirming(false))}>
                Delete comment
              </Button>
              <Button variant="ghost" size="xs" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error && <div role="alert" className="mt-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{error}</div>}
      </div>
    </li>
  );
}

/** What the thread lends whatever sits under it (the composer). */
export interface IssueThreadControls {
  /** Puts a comment the provider just took at the end of the thread. */
  append: (comment: IssueComment) => void;
  /** Reads the thread again. */
  reload: () => void;
}

/**
 * An issue's discussion, under its description. Every comment is read (the
 * cursor pages from the oldest), the most recent `THREAD_WINDOW` are shown,
 * and "Show earlier comments" uncovers older ones a window at a time.
 * `refreshKey` reads it again, keeping what is on screen until the answer
 * comes. `footer` is rendered under the comments once they are read, and
 * `onComments` hears the thread whenever it changes (for the agent's prompt).
 * Render one per issue (`key` it by provider and id), so nothing in flight
 * for one issue lands on another.
 */
export function IssueCommentThread({
  projectPath,
  provider,
  issueId,
  refreshKey = 0,
  footer,
  onComments,
}: {
  projectPath: string;
  provider: IssueProvider;
  issueId: string;
  refreshKey?: number;
  footer?: (controls: IssueThreadControls) => ReactNode;
  onComments?: (thread: IssueThread) => void;
}) {
  const [comments, setComments] = useState<IssueComment[] | null>(null);
  // Older comments past what is kept, which only the website shows.
  const [omitted, setOmitted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState(THREAD_WINDOW);
  const [reloads, setReloads] = useState(0);

  // A refresh keeps the comments on screen, and how far back they are open, until the answer comes.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    readAllComments(projectPath, provider, issueId)
      .then((thread) => {
        if (!live) return;
        setComments(thread.comments);
        setOmitted(thread.omitted);
      })
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [projectPath, provider, issueId, refreshKey, reloads]);

  useEffect(() => {
    if (comments) onComments?.({ comments, omitted });
  }, [comments, omitted, onComments]);

  const replace = (next: IssueComment) => setComments((all) => all?.map((each) => (each.id === next.id ? next : each)) ?? all);
  const remove = (id: string) => setComments((all) => all?.filter((each) => each.id !== id) ?? all);
  const append = useCallback((comment: IssueComment) => {
    setComments((all) => [...(all ?? []).filter((each) => each.id !== comment.id), comment]);
    setShown((count) => count + 1);
  }, []);
  const reload = useCallback(() => setReloads((count) => count + 1), []);

  const total = comments?.length ?? 0;
  const hidden = Math.max(0, total - shown);
  const visible = comments ? comments.slice(hidden) : [];

  return (
    <section aria-label="Comments" className="min-w-0">
      <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
        Comments
        {comments && total > 0 && <span className="font-normal normal-case tracking-normal">{total + omitted}</span>}
        {loading && comments && <Loader2 className="size-3 animate-spin" aria-label="Refreshing comments" />}
      </h3>
      {error && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1 basis-40">Couldn’t load the comments. {error}</span>
          <Button variant="ghost" size="xs" disabled={loading} onClick={reload}>
            Try again
          </Button>
        </div>
      )}
      {!comments ? (
        loading && <div className="mt-2 flex items-center gap-1.5 text-xs text-faint"><Loader2 className="size-3 animate-spin" /> Loading comments…</div>
      ) : total === 0 ? (
        <div className="mt-2 text-sm text-faint">No comments yet.</div>
      ) : (
        <>
          {omitted > 0 && (
            <div className="mt-1.5 text-[11px] text-faint">
              Showing the newest {total} comments. {omitted} older {omitted === 1 ? "one is" : "ones are"} only on the website; open the issue in your browser to read {omitted === 1 ? "it" : "them"}.
            </div>
          )}
          {hidden > 0 && (
            <Button variant="ghost" size="xs" className="mt-1.5" onClick={() => setShown((count) => count + THREAD_WINDOW)}>
              Show earlier comments ({hidden})
            </Button>
          )}
          <ol className="divide-y divide-hairline">
            {visible.map((comment) => (
              <IssueCommentItem
                key={comment.id}
                comment={comment}
                onEdit={async (body) => replace(await issueOps.commentEdit(projectPath, provider, issueId, comment.id, body))}
                onDelete={async () => {
                  await issueOps.commentDelete(projectPath, provider, issueId, comment.id);
                  remove(comment.id);
                }}
              />
            ))}
          </ol>
        </>
      )}
      {comments && footer?.({ append, reload })}
    </section>
  );
}
