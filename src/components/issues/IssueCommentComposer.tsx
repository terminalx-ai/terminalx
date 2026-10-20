import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/chat/Markdown";
import { DictationStatus, MicButton, useDictationInto, useDictationShortcuts } from "@/components/chat/Dictation";
import { Avatar, matchesPerson } from "@/components/issues/People";
import { UserAvatar, type IssueThreadControls } from "@/components/issues/IssueCommentThread";
import { MarkdownEditor } from "@/components/issues/MarkdownEditor";
import type { Issue } from "@/lib/api";
import { cn } from "@/lib/cn";
import { stopDictation } from "@/lib/dictation";
import { getDraft, setDraft, useDraft } from "@/lib/drafts";
import {
  issueDraftKey,
  postIssueComment,
  retryIssueComment,
  settleIssuePost,
  useIssueOutbox,
  type IssueRef,
  type OutgoingComment,
  type PostHooks,
} from "@/lib/issueDrafts";
import { issueOps, type IssueUser } from "@/lib/issueOps";
import { isMac } from "@/lib/shortcuts";

/** The most people the mention list offers at once. */
const MENTIONS_SHOWN = 6;

/** The `@word` the caret is at the end of, if any. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|[^\w`])@([\w-]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

/**
 * How the provider writes a mention, or null where it has none: `@login` on
 * GitHub; on Linear the member's profile link, from the workspace in the
 * issue's address and the member's display name (what `IssueUser.name` is).
 */
export function mentionFor(provider: Issue["provider"], issueUrl: string | undefined): ((person: IssueUser) => string | null) | null {
  if (provider === "github") return (person) => (person.login ? `@${person.login}` : null);
  const workspace = /^https:\/\/linear\.app\/([^/]+)\//.exec(issueUrl ?? "")?.[1];
  if (!workspace) return null;
  return (person) => (person.name ? `https://linear.app/${workspace}/profiles/${encodeURIComponent(person.name)}` : null);
}

/** True when the text is typed somewhere: an input, a text box, editable content. */
function editable(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Whether the dictation keys are this box's: while it has the focus, or
 * nothing else that takes text does (so words never land here while the
 * title or description is being edited).
 */
function useDictationHere(area: RefObject<HTMLTextAreaElement | null>): boolean {
  const [here, setHere] = useState(true);
  useEffect(() => {
    const follow = () => setHere(document.activeElement === area.current || !editable(document.activeElement));
    follow();
    document.addEventListener("focusin", follow);
    document.addEventListener("focusout", follow);
    return () => {
      document.removeEventListener("focusin", follow);
      document.removeEventListener("focusout", follow);
    };
  }, [area]);
  return here;
}

/**
 * A comment on its way: "Sending…" until the provider has it, or why it isn't
 * there with Retry and Discard. One that went in while closing the issue
 * did not says so, with "Try closing again" and Dismiss (which keeps it).
 */
function OutgoingItem({ post, author, onRetry, onDiscard }: { post: OutgoingComment; author?: IssueUser | null; onRetry: () => void; onDiscard: () => void }) {
  const failed = post.status === "failed";
  const posted = failed && !!post.posted;
  return (
    <li
      className="flex min-w-0 gap-2.5 py-2.5"
      aria-label={posted ? "Comment posted, issue not closed" : failed ? "Comment not posted" : "Comment sending"}
      data-outgoing={post.status}
    >
      <UserAvatar user={author} className={cn("mt-0.5", !failed && "opacity-60")} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate font-medium text-foreground">{author?.name || author?.login || "You"}</span>
          {failed ? (
            <span className="shrink-0 text-destructive">{posted ? "posted · issue not closed" : "not posted"}</span>
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              <Loader2 className="size-3 animate-spin" /> {post.posted && post.close ? "Closing…" : "Sending…"}
            </span>
          )}
        </div>
        <div className={cn("mt-0.5 text-[13px]", !failed && !post.posted && "opacity-60")}>
          <Markdown text={post.body} />
        </div>
        {failed && (
          <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
            <span className="min-w-0 flex-1 basis-40">{post.error || "The comment couldn’t be posted."}</span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button variant="ghost" size="xs" onClick={onDiscard}>
                {posted ? "Dismiss" : "Discard"}
              </Button>
              <Button variant="secondary" size="xs" onClick={onRetry}>
                {posted ? "Try closing again" : "Retry"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The comment box under an issue's thread. What is typed is the issue's
 * draft (`@/lib/issueDrafts`), kept across switching issues and restarts.
 * **Comment** (or ⌘/Ctrl+Enter) empties the box and shows the comment at
 * the end of the thread as sending; the provider's answer turns it into a
 * comment of the thread, and a refusal keeps its text there with Retry and
 * Discard. On GitHub "Close with comment" also closes the issue as
 * completed. Typing `@` offers the people the assignee picker does (GitHub).
 * Render one per issue (`key` it by provider and id).
 */
export function IssueCommentComposer({
  projectPath,
  issue,
  controls,
  viewer,
  busy = false,
  hooks,
}: {
  projectPath: string;
  issue: Pick<Issue, "provider" | "id" | "stateType" | "url">;
  controls: IssueThreadControls;
  /** Who the reader is, shown on their comments while they are on their way. */
  viewer?: IssueUser | null;
  /** A change to the issue's status is on its way: "Close with comment" waits for it. */
  busy?: boolean;
  hooks?: PostHooks;
}) {
  const ref: IssueRef = useMemo(() => ({ projectPath, provider: issue.provider, id: issue.id }), [projectPath, issue.provider, issue.id]);
  const key = issueDraftKey(ref);
  const text = useDraft(key);
  const outbox = useIssueOutbox(key);
  const area = useRef<HTMLTextAreaElement>(null);
  const onText = useCallback((value: string) => setDraft(key, value), [key]);
  const dictation = useDictationInto(key, text, onText, area);
  useDictationShortcuts(dictation, useDictationHere(area));
  const latestHooks = useRef(hooks);
  latestHooks.current = hooks;

  // Posts the provider has are the thread's now.
  const { append, reload } = controls;
  const failedSeen = useRef(new Set<string>());
  useEffect(() => {
    for (const post of outbox) {
      if (post.status !== "sent") continue;
      if (post.posted) append(post.posted);
      settleIssuePost(ref, post.id);
    }
    // A post that failed is read again with the thread, so it shows what the provider has.
    const failed = outbox.filter((post) => post.status === "failed" && !failedSeen.current.has(post.id));
    for (const post of failed) failedSeen.current.add(post.id);
    if (failed.length) reload();
  }, [outbox, append, reload, ref]);
  const dismiss = (post: OutgoingComment) => {
    // The comment the provider took stays in the thread.
    if (post.posted) append(post.posted);
    settleIssuePost(ref, post.id);
  };

  const sending = outbox.some((post) => post.status === "sending");
  const canClose = issue.provider === "github" && issue.stateType !== "completed" && issue.stateType !== "canceled";
  const empty = !text.trim();

  const post = async (close: boolean) => {
    if (sending || (close && busy) || !getDraft(key).trim()) return;
    // The last words heard belong to this comment.
    if (dictation.dictating) await stopDictation();
    const body = getDraft(key);
    if (!body.trim()) return;
    setDraft(key, "");
    setMention(null);
    void postIssueComment(ref, body, close, hooksNow());
    area.current?.focus();
  };
  const hooksNow = (): PostHooks => ({
    begin: (k) => latestHooks.current?.begin?.(k),
    end: (k) => latestHooks.current?.end?.(k),
    onIssue: (value) => latestHooks.current?.onIssue?.(value),
  });

  // `@` mentions, from the people the assignee picker offers: `@login` on
  // GitHub, and on Linear a link to the member's profile, which Linear shows
  // as a mention of them.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [people, setPeople] = useState<IssueUser[] | null>(null);
  const [active, setActive] = useState(0);
  const mentionOf = useMemo(() => mentionFor(issue.provider, issue.url), [issue.provider, issue.url]);
  const mentions = !!mentionOf;
  useEffect(() => {
    if (!mentions || !mention || people) return;
    let live = true;
    issueOps
      .options(projectPath, issue.provider, { id: issue.id })
      .then((options) => live && setPeople(options.members))
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [mentions, mention, people, projectPath, issue.provider, issue.id]);
  const offered = mention && people && mentionOf ? people.filter((person) => mentionOf(person) && matchesPerson(person, mention.query)).slice(0, MENTIONS_SHOWN) : [];
  const follow = () => {
    const el = area.current;
    if (!mentions || !el) return;
    const next = mentionAt(el.value, el.selectionStart ?? el.value.length);
    setMention((now) => (now?.start === next?.start && now?.query === next?.query ? now : next));
    if (next?.query !== mention?.query) setActive(0);
  };
  const pick = (person: IssueUser) => {
    const el = area.current;
    const said = mentionOf?.(person);
    if (!mention || !said) return;
    const caret = el?.selectionStart ?? text.length;
    const inserted = `${said} `;
    setDraft(key, `${text.slice(0, mention.start)}${inserted}${text.slice(caret)}`);
    setMention(null);
    const at = mention.start + inserted.length;
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!offered.length || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
    } else if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
      event.preventDefault();
      pick(offered[Math.min(active, offered.length - 1)]);
    } else if (event.key === "Escape") {
      // Closes the list and stops there.
      event.preventDefault();
      event.stopPropagation();
      setMention(null);
    }
  };
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.addEventListener("keyup", follow);
    el.addEventListener("click", follow);
    return () => {
      el.removeEventListener("keyup", follow);
      el.removeEventListener("click", follow);
    };
  });

  return (
    <div className="mt-2 min-w-0">
      {outbox.some((each) => each.status !== "sent") && (
        <ol className="divide-y divide-hairline" aria-label="Comments being posted">
          {outbox.map(
            (each) =>
              each.status !== "sent" && (
                <OutgoingItem
                  key={each.id}
                  post={each}
                  author={viewer}
                  onRetry={() => void retryIssueComment(ref, each.id, hooksNow())}
                  onDiscard={() => dismiss(each)}
                />
              ),
          )}
        </ol>
      )}
      <div className="mt-2">
        <DictationStatus dictation={dictation} />
        <MarkdownEditor
          label="Comment"
          placeholder="Leave a comment"
          value={text}
          onChange={(value) => {
            onText(value);
            requestAnimationFrame(follow);
          }}
          textareaRef={area}
          onKeyDown={onKeyDown}
          onSubmit={() => void post(false)}
          hint={isMac ? "⌘↩ to comment" : "Ctrl+Enter to comment"}
        >
          <MicButton dictation={dictation} />
          {canClose && (
            <Button variant="ghost" size="xs" disabled={empty || sending || busy} onClick={() => void post(true)}>
              Close with comment
            </Button>
          )}
          <Button variant="accent" size="xs" disabled={empty || sending} onClick={() => void post(false)}>
            {sending && <Loader2 className="animate-spin" />}
            Comment
          </Button>
        </MarkdownEditor>
        {offered.length > 0 && (
          <ul role="listbox" aria-label="Mention someone" className="mt-1 max-w-72 overflow-hidden rounded-md bg-popover py-1 shadow-md hairline">
            {offered.map((person, index) => (
              <li
                key={person.id}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  // Keeps the focus, and the caret, in the box.
                  event.preventDefault();
                  pick(person);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn("flex min-w-0 cursor-default items-center gap-2 px-2 py-1 text-xs", index === active && "bg-veil-strong")}
              >
                <Avatar person={person} className="size-4" />
                <span className="truncate font-medium">{person.login ?? person.name}</span>
                {person.login && person.name && person.name !== person.login && <span className="truncate text-faint">{person.name}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
