import type { CSSProperties } from "react";
import { Sparkles } from "@/icons";
import { cn } from "@/lib/cn";

const ME = "var(--color-accent)";
const DESIGNER = "var(--color-info)";
const AGENT = "var(--color-add)";

/**
 * A picture of a shared session, told at the prompt, since that is where
 * people meet in one. Three parties give input (you, a designer and an agent
 * that joined the session); the model running the session gives the output.
 * You go to the prompt, type and send, and the model answers; the designer
 * joins, does the same, and the model answers; then the agent sends its
 * prompt. Inputs carry their sender's name; output carries the model's mark.
 * One loop is nine seconds (app.css, `.cs-*`); under reduced motion it holds
 * the finished conversation.
 */
export function CollaborationScene({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative h-56 w-full", className)} data-testid="collaboration-scene">
      {/* The conversation as the app draws it: input, output, input, output, input. A prompt is a
          card with its sender's name; the model's answer is plain lines under its mark. */}
      <div className="absolute inset-x-[12%] top-0 flex flex-col gap-1.5">
        <Prompt className="cs-row-1" color={ME} who="You" width="58%" />
        <Output turn={1} lines={["92%", "64%"]} />
        <Prompt className="cs-row-3" color={DESIGNER} who="Designer" width="46%" />
        <Output turn={2} lines={["84%", "52%"]} />
        <Prompt className="cs-row-5" color={AGENT} who="Agent" width="52%" />
      </div>
      {/* The one prompt they share: whoever is at it lights its edge in their colour and types into it. */}
      <div className="absolute inset-x-[12%] bottom-8 flex h-8 items-center gap-2 rounded-lg bg-veil-raised px-2.5">
        <span className="cs-ring cs-ring-me pointer-events-none absolute inset-0 rounded-lg" style={{ boxShadow: `inset 0 0 0 1.5px ${ME}` }} />
        <span className="cs-ring cs-ring-designer pointer-events-none absolute inset-0 rounded-lg" style={{ boxShadow: `inset 0 0 0 1.5px ${DESIGNER}` }} />
        <span className="cs-ring cs-ring-agent pointer-events-none absolute inset-0 rounded-lg" style={{ boxShadow: `inset 0 0 0 1.5px ${AGENT}` }} />
        <span className="relative h-2 flex-1">
          <span className="cs-typing cs-typing-me absolute left-0 top-0.5 h-1.5 rounded-full bg-foreground/30" />
          <span className="cs-typing cs-typing-designer absolute left-0 top-0.5 h-1.5 rounded-full bg-foreground/30" />
          <span className="cs-typing cs-typing-agent absolute left-0 top-0.5 h-1.5 rounded-full bg-foreground/30" />
        </span>
        <span className="cs-send size-4 shrink-0 rounded-full bg-foreground/80" />
      </div>
      {/* Who has come in, under the prompt: the agent from the start, the designer just before their turn. The agent
          has no pointer: it sends through the session, not by hand. */}
      <div className="absolute inset-x-[12%] bottom-1 flex h-5 items-center gap-3 text-[10.5px] text-muted-foreground">
        <Joined className="cs-joined-agent" color={AGENT} who="Agent" />
        <Joined className="cs-joined-designer" color={DESIGNER} who="Designer" />
      </div>
      <Cursor className="cs-cursor-me" color={ME} label="You" />
      <Cursor className="cs-cursor-designer" color={DESIGNER} label="Designer" />
    </div>
  );
}

/** Input: a prompt as the transcript draws it, a card, with who sent it and a line of their words. */
function Prompt({ className, color, who, width }: { className: string; color: string; who: string; width: string }) {
  return (
    <span className={cn("cs-row flex h-5 items-center gap-2 rounded-md bg-veil-raised px-1.5", className)}>
      <Tag color={color}>{who}</Tag>
      <span className="h-1.5 rounded-full bg-foreground/30" style={{ width } as CSSProperties} />
    </span>
  );
}

/** Output: the model's mark, a moment of thinking dots, then its answer as plain lines growing in. */
function Output({ turn, lines }: { turn: 1 | 2; lines: string[] }) {
  return (
    <span className={cn("cs-row flex items-start gap-2 px-1.5", `cs-agent-${turn}`)}>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"><Sparkles className="size-3.5" /></span>
      <span className="relative flex min-h-4 flex-1 flex-col justify-center gap-1.5 py-[3px]">
        <span className={cn("cs-think absolute left-0 top-1.5 flex items-center gap-0.5", `cs-think-${turn}`)}>
          <span className="cs-dot size-1 rounded-full bg-muted-foreground" />
          <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0.15s" }} />
          <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0.3s" }} />
        </span>
        {lines.map((width, i) => (
          <span key={i} className={cn("cs-reply block h-1.5 rounded-full bg-foreground/20", `cs-reply-${turn}`)} style={{ width, animationDelay: `${i * 0.12}s` }} />
        ))}
      </span>
    </span>
  );
}

/** A name on its colour, as a collaborator's cursor carries it; the same tag marks their messages. */
function Tag({ color, children }: { color: string; children: string }) {
  return (
    <span className="shrink-0 rounded-full px-1.5 text-[9.5px] font-medium leading-4 text-black/80" style={{ background: color }}>
      {children}
    </span>
  );
}

/** "Agent joined", the way a shared session says someone came in. */
function Joined({ className, color, who }: { className: string; color: string; who: string }) {
  return (
    <span className={cn("cs-joined flex items-center gap-1.5", className)}>
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {who} joined
    </span>
  );
}

/** A collaborator's pointer, tip at the top left, with their name tag. */
function Cursor({ className, color, label }: { className: string; color: string; label: string }) {
  return (
    <span className={cn("cs-cursor absolute flex items-start", className)}>
      <svg width="16" height="16" viewBox="0 0 16 16" className="drop-shadow-[0_1px_1px_rgb(0_0_0/0.4)]">
        <path d="M2.5 1.5v11.2l3.1-2.9 2.2 4.7 2-.9-2.2-4.6h4.3z" fill={color} stroke="white" strokeWidth="1.1" strokeLinejoin="round" />
      </svg>
      <span className="-ml-0.5 mt-3.5"><Tag color={color}>{label}</Tag></span>
    </span>
  );
}
