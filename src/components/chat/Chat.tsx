import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Transcript } from "@/lib/transcript";
import type { StreamBlock } from "@/lib/agentEvents";
import { TurnBlock } from "./TurnBlock";
import { PermissionCard, QuestionCard } from "./AskCards";
import { RaccoonRunner, RaccoonScene } from "@/components/raccoon/Raccoon";

const NEAR_BOTTOM_PX = 40;
const FIRST_MOUNT = 12;
const MOUNT_STEP = 12;

/**
 * The transcript scroller.
 *
 * Follow pin: a ref written on scroll, resize and turn change; only an upward
 * wheel gesture unpins, so a resize clamp or a delta re-pin can't fight it.
 * A ResizeObserver on both the scroller and its content re-takes the bottom
 * after async growth (highlighting, images) with no React commit involved.
 * Long logs mount the newest turns first and backfill above in idle steps,
 * anchoring scrollTop so the reader's view never moves.
 */
export function Chat({
  transcript,
  stream,
  cwd,
  live,
  onAnswerPermission,
  onAnswerQuestions,
  answering,
  footer,
}: {
  transcript: Transcript;
  stream: StreamBlock[];
  cwd?: string;
  live: boolean;
  onAnswerPermission: (requestId: string, optionId: string) => void;
  onAnswerQuestions: (requestId: string, answers: Record<string, string>) => void;
  answering: boolean;
  footer: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const turns = transcript.turns;
  const [oldestMounted, setOldestMounted] = useState(() => Math.max(0, turns.length - FIRST_MOUNT));

  const pinToBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Backfill older turns above, one step per macrotask, keeping the view anchored.
  useEffect(() => {
    if (oldestMounted <= 0) return;
    const id = window.setTimeout(() => {
      const el = scroller.current;
      const anchor = content.current?.querySelector<HTMLElement>("[data-turn]");
      const before = anchor?.getBoundingClientRect().top ?? 0;
      setOldestMounted((o) => Math.max(0, o - MOUNT_STEP));
      requestAnimationFrame(() => {
        if (!el) return;
        if (pinned.current) {
          pinToBottom();
        } else if (anchor) {
          const after = anchor.getBoundingClientRect().top;
          el.scrollTop += after - before;
        }
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [oldestMounted, pinToBottom]);

  // Wheel up unpins immediately; scroll position re-confirms the pin.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        pinned.current = false;
        setAtBottom(false);
      }
    };
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = dist < NEAR_BOTTOM_PX;
      if (near) pinned.current = true;
      setAtBottom(near);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

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
    pinned.current = true;
    pinToBottom();
    setAtBottom(true);
  }, [lastPromptSeq, pinToBottom]);

  const working = live && !!transcript.workingSince && (transcript.modelRequestOpen || !stream.length);
  const streamingTool = stream.find((s) => s.kind === "tool_use" && !s.done);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-none scrollbar-thin [overflow-anchor:none]">
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
                stream={isLast && live ? stream : []}
                working={isLast && working && !transcript.pendingAsks.length && !transcript.compacting}
                streamingTool={isLast && live ? streamingTool : undefined}
              />
            );
          })}
          {transcript.compacting && (
            <div className="mb-3 px-1.5 text-[13px] text-shimmer">Compacting context</div>
          )}
          {transcript.retry && live && (
            <div className="mb-3 px-1.5 text-[13px] text-warning">
              Retrying ({transcript.retry.attempt}/{transcript.retry.maxRetries})
              {transcript.retry.reason ? ` · ${transcript.retry.reason}` : ""}
            </div>
          )}
          {transcript.pendingAsks.map((ask) => (
            <div key={ask.requestId} className="mb-3">
              {ask.kind === "permission" ? (
                <PermissionCard ask={ask} busy={answering} onAnswer={(o) => onAnswerPermission(ask.requestId, o)} />
              ) : (
                <QuestionCard ask={ask} busy={answering} onAnswer={(a) => onAnswerQuestions(ask.requestId, a)} />
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
            pinned.current = true;
            pinToBottom(!live);
            setAtBottom(true);
          }}
        >
          <ArrowDown /> Latest
        </Button>
      </div>
      <div className="relative shrink-0">
        <RaccoonRunner active={live} obstacle={!atBottom} />
        {footer}
      </div>
    </div>
  );
}
