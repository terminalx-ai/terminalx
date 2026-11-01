import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Transcript } from "@/lib/transcript";
import type { StreamBlock } from "@/lib/agentEvents";
import { SendingMessage, TurnBlock } from "./TurnBlock";
import { PermissionCard, QuestionCard } from "./AskCards";
import { RaccoonRunner, RaccoonScene } from "@/components/raccoon/Raccoon";
import { READER_SCROLL_EVENT } from "@/lib/shellScroll";

const NEAR_BOTTOM_PX = 40;
/** How many of the newest turns are drawn before the scroller has a size (a tab not on screen). */
const FIRST_MOUNT = 12;
/** Drawn beyond each edge of the view, so a scroll shows turns that are already laid out. */
const OVERSCAN_PX = 1200;
/** What a turn not drawn yet is taken to be, until turns have been measured. */
const ESTIMATED_TURN_PX = 240;
/** The stream of a turn that is not the live one: one array, so a memoised row is not drawn again for a new `[]`. */
const NO_STREAM: StreamBlock[] = [];

/** The first index whose value is past `at` in an ascending list. */
function firstAfter(values: number[], at: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] > at) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The turns to draw for a view of `viewport` pixels whose top is `top` pixels
 * into the list: those it shows, and `OVERSCAN_PX` either side (#727).
 * `tops` holds each turn's top and, last, the list's end.
 */
export function visibleTurns(tops: number[], top: number, viewport: number, tail: boolean): { start: number; end: number } {
  const count = tops.length - 1;
  if (viewport <= 0) return { start: Math.max(0, count - FIRST_MOUNT), end: count };
  const from = tail ? Math.max(0, tops[count] - viewport) : top;
  // The first turn whose bottom is below the band's top, through the last whose top is above its bottom.
  const start = Math.min(Math.max(0, firstAfter(tops, from - OVERSCAN_PX) - 1), Math.max(0, count - 1));
  const end = tail ? count : Math.min(count, Math.max(start + 1, firstAfter(tops, from + viewport + OVERSCAN_PX) - 1));
  return { start, end: Math.max(start, end) };
}

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
 *
 * Only the turns in and near the view are drawn (#727): spacers stand for the
 * rest, at the heights the turns had when they were last drawn (or an
 * estimate for one never drawn). A turn that comes into view at a height
 * other than its spacer's moves the turn the reader is on by exactly that
 * much, so scrollTop is shifted to keep it where it was.
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
  loading = false,
  footer,
  onSendQueuedNow,
  sending = null,
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
  /** The conversation is on its way (a cloud tab opened here for the first time): empty is not "nothing yet". */
  loading?: boolean;
  footer: React.ReactNode;
  /** Send a message queued behind the running turn now, where the backend can (local). */
  onSendQueuedNow?: (seq: number) => void;
  /** A message sent from the composer that the runtime has not recorded yet: drawn last, as sending (#727). */
  sending?: { text: string; images: { url: string; name?: string }[]; pressedAt: number } | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** The scrollTop last seen or set; a scroll event's change from it is the reader's own movement. */
  const lastTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const turns = transcript.turns;
  /** Each drawn turn's height as last measured, by key; one never drawn is taken to be `ESTIMATED_TURN_PX`. */
  const heights = useRef(new Map<string, number>());
  /** The turns drawn while the reader is off the bottom, and the scroller's height. */
  const [band, setBand] = useState({ start: 0, end: 0, height: 0 });
  const topSpacer = useRef<HTMLDivElement>(null);
  const tops = useRef<number[]>([0]);

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

  // Each turn's top in the list, and the list's end. A fixed estimate for
  // the turns never drawn keeps the spacer above the view from changing
  // while the view stays where it is.
  const measured = heights.current;
  const turnTops: number[] = [0];
  for (const turn of turns) turnTops.push(turnTops[turnTops.length - 1] + (measured.get(turn.key) ?? ESTIMATED_TURN_PX));
  tops.current = turnTops;
  // A new prompt is followed from the render it arrives in, not one later;
  // so is the reader's own message while it is being sent.
  const lastPrompt = `${turns[turns.length - 1]?.prompt?.seq ?? ""}:${sending?.pressedAt ?? ""}`;
  const followedPrompt = useRef(lastPrompt);
  const tail = pinned.current || followedPrompt.current !== lastPrompt;
  // Off the bottom, the band the view last asked for; one not worked out yet (or for a list since cut short) is the tail's.
  const known = band.end > band.start && band.end <= turns.length;
  const { start, end } = tail || !known ? visibleTurns(turnTops, 0, band.height, true) : band;

  /** Which turns the view needs drawn, from where it is over the list now. */
  const readView = useCallback(() => {
    const el = scroller.current;
    const spacer = topSpacer.current;
    if (!el || !spacer) return;
    // The list starts below the content's padding and anything drawn ahead of it.
    const listTop = spacer.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const height = el.clientHeight;
    const next = visibleTurns(tops.current, Math.max(0, el.scrollTop - listTop), height, false);
    setBand((was) => (was.start === next.start && was.end === next.end && was.height === height ? was : { ...next, height }));
  }, []);

  /**
   * Measure the turns drawn. One wholly above the view that is taller or
   * shorter than was taken for it (a turn drawn for the first time, or one
   * still settling) moved the turn the reader is on by the difference, so
   * scrollTop takes that back. Says whether any height changed.
   */
  const measure = useCallback((): boolean => {
    const el = scroller.current;
    const c = content.current;
    if (!el || !c) return false;
    const box = el.getBoundingClientRect();
    let shift = 0;
    let changed = false;
    for (const node of c.querySelectorAll<HTMLElement>(":scope > [data-turn]")) {
      const rect = node.getBoundingClientRect();
      const key = node.dataset.turn!;
      const was = heights.current.get(key);
      if (rect.height <= 0 || rect.height === was) continue;
      heights.current.set(key, rect.height);
      changed = true;
      if (rect.bottom <= box.top) shift += rect.height - (was ?? ESTIMATED_TURN_PX);
    }
    if (shift && !pinned.current) {
      el.scrollTop += shift;
      lastTop.current = el.scrollTop;
    }
    return changed;
  }, []);

  // After every commit, before paint: what was drawn is measured, and the
  // band worked out again on the heights it really has.
  useLayoutEffect(() => {
    if (measure()) readView();
  });

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
      readView();
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
  }, [follow, pinToBottom, readView]);

  // Heights change without a commit: re-pin after layout, before paint.
  useLayoutEffect(() => {
    const el = scroller.current;
    const c = content.current;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      measure();
      if (pinned.current) pinToBottom();
      // The scroller gained a size (its tab came on screen) or changed it.
      readView();
    });
    ro.observe(el);
    ro.observe(c);
    return () => ro.disconnect();
  }, [pinToBottom, readView, measure]);

  // New content while pinned keeps the bottom in view.
  useLayoutEffect(() => {
    if (pinned.current) pinToBottom();
  });

  useLayoutEffect(() => {
    followedPrompt.current = lastPrompt;
    follow(true);
    pinToBottom();
  }, [lastPrompt, follow, pinToBottom]);

  const working = progressing && !!transcript.workingSince && (transcript.modelRequestOpen || !stream.length);
  const streamingTool = stream.find((s) => s.kind === "tool_use" && !s.done);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} data-chat-scroller className="min-h-0 flex-1 overflow-y-auto overscroll-none scrollbar-thin [overflow-anchor:none]">
        <div ref={content} className="mx-auto w-full max-w-3xl px-6 pb-4 pt-5">
          {!turns.length && !live && !sending && loading && (
            // Loading is a label alone; the scene is for a conversation that really is empty.
            <p role="status" className="flex h-[40vh] min-h-[160px] items-center justify-center gap-1.5 text-xs text-faint">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Loading the conversation…
            </p>
          )}
          {!turns.length && !live && !sending && !loading && (
            <div className="flex h-[40vh] min-h-[160px] flex-col justify-end">
              <RaccoonScene />
              <p className="mt-3 text-center text-xs text-faint">Nothing here yet. Ask for something below.</p>
            </div>
          )}
          <div ref={topSpacer} data-spacer aria-hidden style={{ height: turnTops[start] }} />
          {turns.slice(start, end).map((t, i) => {
            const isLast = start + i === turns.length - 1;
            return (
              <TurnBlock
                key={t.key}
                turn={t}
                cwd={cwd}
                sessionId={sessionId}
                stream={isLast && live ? stream : NO_STREAM}
                working={isLast && working && !transcript.pendingAsks.length && !transcript.compacting}
                streamingTool={isLast && live ? streamingTool : undefined}
                // Only what waits behind the running turn can go now; a note left in a turn that is over cannot (#551).
                onSendQueuedNow={live && t.live ? onSendQueuedNow : undefined}
              />
            );
          })}
          <div data-spacer aria-hidden style={{ height: turnTops[turns.length] - turnTops[end] }} />
          {sending && <SendingMessage message={sending} cwd={cwd} />}
          {transcript.compacting && (
            <div className="mb-3 px-1.5 text-[13px] text-shimmer">Compacting context…</div>
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
                <PermissionCard ask={ask} busy={answering} blockedReason={answerBlockedReason} showDetail={askDetail} onAnswer={(o) => onAnswerPermission(ask.requestId, o)} />
              ) : (
                <QuestionCard ask={ask} busy={answering} blockedReason={answerBlockedReason} onAnswer={(a) => onAnswerQuestions(ask.requestId, a)} />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="relative shrink-0">
        {/* Above the composer, never behind it: the composer is see-through. */}
        <div
          className={cn(
            "pointer-events-none absolute bottom-full left-1/2 z-10 mb-3 -translate-x-1/2 transition-[opacity,visibility]",
            atBottom ? "invisible opacity-0" : "opacity-100",
          )}
        >
          <Button
            size="sm"
            variant="secondary"
            // Solid, on the chat's own colour: it floats over the transcript, and text must not show through it.
            className="pointer-events-auto gap-1 rounded-full bg-chat text-muted-foreground shadow-surface hairline hover:bg-chat hover:text-foreground"
            tabIndex={atBottom ? -1 : undefined}
            onClick={() => {
              follow(true);
              pinToBottom(!live);
            }}
          >
            <ArrowDown /> Latest
          </Button>
        </div>
        <RaccoonRunner active={progressing} obstacle={!atBottom} />
        {footer}
      </div>
    </div>
  );
}
