import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

const ME = "var(--color-accent)";
const DESIGNER = "var(--color-info)";
const AGENT = "var(--color-add)";

/**
 * A wordless picture of a shared session, told at the prompt, since that is
 * where people meet in one. Three parties: you, the agent and a designer.
 * You go to the prompt, type and send; the agent thinks, then adds its
 * answer; the designer takes the prompt and does the same; the agent answers
 * again. Each party's messages are in their colour. One loop is nine seconds
 * (app.css, `.cs-*`); under reduced motion it holds the finished conversation.
 */
export function CollaborationScene({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative h-48 w-full", className)} data-testid="collaboration-scene">
      {/* The conversation: people's prompts on the right in their colour, the agent's answers on the left. */}
      <div className="absolute inset-x-[12%] top-2 flex flex-col gap-2">
        <Row className="cs-row-1 self-end" width="42%" color={ME} />
        <AgentRow turn={1} width="64%" />
        <Row className="cs-row-3 self-end" width="36%" color={DESIGNER} />
        <AgentRow turn={2} width="56%" />
      </div>
      {/* The one prompt they share: whoever is at it lights its edge in their colour and types into it. */}
      <div className="absolute inset-x-[12%] bottom-8 flex h-8 items-center gap-2 rounded-lg bg-veil-raised px-2.5">
        <span className="cs-ring cs-ring-me pointer-events-none absolute inset-0 rounded-lg" style={{ boxShadow: `inset 0 0 0 1.5px ${ME}` }} />
        <span className="cs-ring cs-ring-designer pointer-events-none absolute inset-0 rounded-lg" style={{ boxShadow: `inset 0 0 0 1.5px ${DESIGNER}` }} />
        <span className="relative h-2 flex-1">
          <span className="cs-typing cs-typing-me absolute left-0 top-0 h-2 rounded-full" style={{ background: tint(ME) }} />
          <span className="cs-typing cs-typing-designer absolute left-0 top-0 h-2 rounded-full" style={{ background: tint(DESIGNER) }} />
        </span>
        <span className="cs-send size-4 shrink-0 rounded-full bg-foreground/80" />
      </div>
      {/* Who has come in, under the prompt: the agent is there from the start, the designer joins before their turn. */}
      <div className="absolute inset-x-[12%] bottom-1 flex h-5 items-center gap-3 text-[10.5px] text-muted-foreground">
        <Joined className="cs-joined-agent" color={AGENT} who="Agent" />
        <Joined className="cs-joined-designer" color={DESIGNER} who="Designer" />
      </div>
      <Cursor className="cs-cursor-me" color={ME} label="You" />
      <Cursor className="cs-cursor-designer" color={DESIGNER} label="Designer" />
    </div>
  );
}

const tint = (color: string) => `color-mix(in oklab, ${color} 60%, transparent)`;

function Row({ className, width, color }: { className: string; width: string; color?: string }) {
  return (
    <span
      className={cn("cs-row block h-2.5 rounded-full", !color && "bg-veil-strong", className)}
      style={{ width, background: color ? tint(color) : undefined } as CSSProperties}
    />
  );
}

/** The agent's turn: its mark, a moment of thinking dots, then its answer growing in. */
function AgentRow({ turn, width }: { turn: 1 | 2; width: string }) {
  return (
    <span className={cn("cs-row flex h-4 items-center gap-1.5", `cs-agent-${turn}`)}>
      <Tag color={AGENT}>Agent</Tag>
      <span className="relative h-2.5 flex-1">
        <span className={cn("cs-think absolute left-0 top-0 flex h-2.5 items-center gap-0.5", `cs-think-${turn}`)}>
          <span className="cs-dot size-1 rounded-full bg-muted-foreground" />
          <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0.15s" }} />
          <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0.3s" }} />
        </span>
        <span className={cn("cs-reply absolute left-0 top-0 block h-2.5 rounded-full", `cs-reply-${turn}`)} style={{ width, background: tint(AGENT) }} />
      </span>
    </span>
  );
}

/** A name on its colour, as a collaborator's cursor carries it. */
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
