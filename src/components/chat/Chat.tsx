import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Transcript } from "@/lib/transcript";
import type { StreamBlock } from "@/lib/agentEvents";
import { TurnBlock } from "./TurnBlock";
import { PermissionCard, QuestionCard } from "./AskCards";
import { RaccoonRunner, RaccoonScene } from "@/components/raccoon/Raccoon";
import { READER_SCROLL_EVENT } from "@/lib/shellScroll";

const NEAR_BOTTOM_PX = 40;
const FIRST_MOUNT = 12;
const MOUNT_STEP = 12;

/**
 * The transcript scroller.
 *
 * Follow pin: a ref the reader's own input decides. An upward wheel (or an
 * upward scrollbar drag, or a key that scrolls up) unpins; a scroll re-pins
 * only when it moved down into the bottom zone, so a small upward step inside
 * that zone can't re-pin and be undone by the next render. Scrolls without
 * input never unpin, so a resize clamp or layout nudge can't fight the pin: a
 * pinned view takes the bottom back from one. Programmatic writes record the
 * position they set, so they never read as the reader moving. Whose turn it
 * is makes no difference: output from a turn someone else drives on a shared
 * workspace is followed exactly like the reader's own.
 * A ResizeObserver on both the scroller and its content re-takes the bottom
 * after async growth (highlighting, images) with no React commit involved.
 * Long logs mount the newest turns first and backfill above in idle steps,
 * shifting scrollTop by exactly the inserted height so the reader's view never moves.
 */
export function Chat({
  sessionId,
  transcript,
  stream,
  cwd,
  live,
  progressing = live,
  onAnswerPermission,
  onAnswerQuestions,
  answering,
  answerBlockedReason,
  askDetail = false,
  footer,
}: {
  sessionId: string;
  transcript: Transcript;
  stream: StreamBlock[];
  cwd?: string;
  live: boolean;
  progressing?: boolean;
  onAnswerPermission: (requestId: string, optionId: string) => void;
  onAnswerQuestions: (requestId: string, answers: Record<string, string>) => void;
  answering: boolean;
  /** Set when this reader may not answer permission requests or questions (a shared workspace's viewer). */
  answerBlockedReason?: string | null;
  /** Quote the command, file or tool a permission request is about (a shared cloud workspace). */
  askDetail?: boolean;
  footer: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The scrollTop last seen or set; a scroll event's change from it is the reader's own movement. */
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const turns = transcript.turns;
  const [oldestMounted, setOldestMounted] = useState(() => Math.max(0, turns.length - FIRST_MOUNT));
  const backfillAnchor = useRef<{ node: HTMLElement; offset: number } | null>(null);

  const follow = useCallback((on: boolean) => {
    pinned.current = on;
    setAtBottom(on);
  }, []);

  const pinToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    if (smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
  }, []);

  /** A node's offset within the content, which the reader's scrolling doesn't change. */
  const offsetInContent = useCallback((node: HTMLElement) => {
    return node.getBoundingClientRect().top - (content.current?.getBoundingClientRect().top ?? 0);
  }, []);

  // Backfill older turns above, one step per macrotask. The step notes where the
  // top turn sits in the content; the commit below moves scrollTop by what landed
  // above it, so scrolling done while the step renders is kept, not undone.
  useEffect(() => {
    if (oldestMounted <= 0) return;
    const id = window.setTimeout(() => {
      const node = content.current?.querySelector<HTMLElement>("[data-turn]");
      backfillAnchor.current = node ? { node, offset: offsetInContent(node) } : null;
      setOldestMounted((o) => Math.max(0, o - MOUNT_STEP));
    }, 0);
    return () => window.clearTimeout(id);
  }, [oldestMounted, offsetInContent]);

  // After a backfill commit, before paint. Pinned views are re-pinned below.
  useLayoutEffect(() => {
    const anchor = backfillAnchor.current;
    backfillAnchor.current = null;
    const el = scroller.current;
    if (!anchor || !el || pinned.current) return;
    el.scrollTop += offsetInContent(anchor.node) - anchor.offset;
    lastTop.current = el.scrollTop;
  }, [oldestMounted, offsetInContent]);

  // Wheel up unpins before the scroll lands, and so do the keys that scroll
  // up and a link that jumps within the transcript. A scroll only unpins while
  // the reader holds the scrollbar: layout can nudge scrollTop up on its own,
  // and a nudge while pinned is taken back at once, so a transcript that then
  // sits idle (or grows by a turn someone else drives) is still at its bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let dragging = false;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && el.scrollTop > 0) follow(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
      const up = e.key === "PageUp" || e.key === "ArrowUp" || e.key === "Home" || (e.key === " " && e.shiftKey);
      if (up && el.scrollTop > 0) follow(false);
    };
    const onReaderScroll = () => follow(false);
    const onPointerDown = () => {
      dragging = true;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onScroll = () => {
      const top = el.scrollTop;
      const moved = top - lastTop.current;
      lastTop.current = top;
      const dist = el.scrollHeight - top - el.clientHeight;
      if (moved < 0 && dragging && dist >= 1) follow(false);
      else if (moved > 0 && dist < NEAR_BOTTOM_PX) follow(true);
      // Not the reader's doing (they would be unpinned by now): back to the bottom.
      else if (moved < 0 && pinned.current && dist >= 1) pinToBottom();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener(READER_SCROLL_EVENT, onReaderScroll);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener(READER_SCROLL_EVENT, onReaderScroll);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("scroll", onScroll);
    };
  }, [follow, pinToBottom]);

  // Heights change without a commit: re-pin after layout, before paint.
  useLayoutEffect(() => {
    const el = scroller.current;
    const c = content.current;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) pinToBottom();
    });
    ro.observe(el);
    ro.observe(c);
    return () => ro.disconnect();
  }, [pinToBottom]);

  // New content while pinned keeps the bottom in view.
  useLayoutEffect(() => {
    if (pinned.current) pinToBottom();
  });

  const lastPromptSeq = turns[turns.length - 1]?.prompt?.seq;
  useLayoutEffect(() => {
    follow(true);
    pinToBottom();
  }, [lastPromptSeq, follow, pinToBottom]);

  const working = progressing && !!transcript.workingSince && (transcript.modelRequestOpen || !stream.length);
  const streamingTool = stream.find((s) => s.kind === "tool_use" && !s.done);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} data-chat-scroller className="min-h-0 flex-1 overflow-y-auto overscroll-none scrollbar-thin [overflow-anchor:none]">
        <div ref={content} className="mx-auto w-full max-w-3xl px-6 pb-4 pt-5">
          {oldestMounted > 0 && (
            <div className="mb-4 text-center text-xs text-faint">Loading earlier turns…</div>
          )}
          {!turns.length && !live && (
            <div className="flex h-[40vh] min-h-[160px] flex-col justify-end">
              <RaccoonScene />
              <p className="mt-3 text-center text-xs text-faint">Nothing here yet. Ask for something below.</p>
            </div>
          )}
          {turns.slice(oldestMounted).map((t, i, arr) => {
            const isLast = i === arr.length - 1;
            return (
              <TurnBlock
                key={t.key}
                turn={t}
                cwd={cwd}
                sessionId={sessionId}
                stream={isLast && live ? stream : []}
                working={isLast && working && !transcript.pendingAsks.length && !transcript.compacting}
                streamingTool={isLast && live ? streamingTool : undefined}
              />
            );
          })}
          {transcript.compacting && progressing && (
            <div className="mb-3 px-1.5 text-[13px] text-shimmer">Compacting context</div>
          )}
          {transcript.retry && progressing && (
            <div className="mb-3 px-1.5 text-[13px] text-warning">
              Retrying ({transcript.retry.attempt}/{transcript.retry.maxRetries})
              {transcript.retry.reason ? ` · ${transcript.retry.reason}` : ""}
            </div>
          )}
          {transcript.pendingAsks.map((ask) => (
            <div key={ask.requestId} className="mb-3">
              {ask.kind === "permission" ? (
                <PermissionCard ask={ask} busy={answering || !!answerBlockedReason} showDetail={askDetail} onAnswer={(o) => onAnswerPermission(ask.requestId, o)} />
              ) : (
                <QuestionCard ask={ask} busy={answering || !!answerBlockedReason} onAnswer={(a) => onAnswerQuestions(ask.requestId, a)} />
              )}
              {answerBlockedReason && (
                <div className="mt-1 px-1.5 text-xs text-muted-foreground" data-testid="answer-blocked">
                  {answerBlockedReason}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div
        className={cn(
          "pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 transition-opacity",
          atBottom ? "opacity-0" : "opacity-100",
        )}
      >
        <Button
          size="sm"
          variant="secondary"
          className="pointer-events-auto gap-1 rounded-full shadow-surface"
          onClick={() => {
            follow(true);
            pinToBottom(!live);
          }}
        >
          <ArrowDown /> Latest
        </Button>
      </div>
      <div className="relative shrink-0">
        <RaccoonRunner active={progressing} obstacle={!atBottom} />
        {footer}
      </div>
    </div>
  );
}
