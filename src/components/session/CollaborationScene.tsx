import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

/**
 * A wordless picture of a shared session: on a canvas, a conversation fills
 * in while three people's cursors move about and take turns at the prompt,
 * each person's messages in their colour. It loops every few seconds and
 * stands still for a reader who asked for reduced motion (app.css, `.cs-*`).
 */
export function CollaborationScene({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("cs-canvas relative h-36 w-full overflow-hidden rounded-xl bg-well hairline", className)}
      data-testid="collaboration-scene"
    >
      {/* The conversation: the agent's replies on the left, people's prompts on the right in their colour. */}
      <div className="absolute inset-x-[18%] top-4 flex flex-col gap-2">
        <Bubble side="left" width="62%" delay={0} />
        <Bubble side="right" width="44%" delay={1.2} color="var(--color-accent)" />
        <Bubble side="left" width="70%" delay={2.4} />
        <Bubble side="right" width="38%" delay={3.6} color="var(--color-info)" />
        <Bubble side="right" width="30%" delay={4.8} color="var(--color-add)" />
      </div>
      {/* The prompt, with someone typing into it. */}
      <div className="absolute inset-x-[18%] bottom-3 flex h-5 items-center gap-1 rounded-md bg-veil-raised px-2">
        <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0s" }} />
        <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0.15s" }} />
        <span className="cs-dot size-1 rounded-full bg-muted-foreground" style={{ animationDelay: "0.3s" }} />
      </div>
      <Cursor path="cs-path-a" color="var(--color-accent)" />
      <Cursor path="cs-path-b" color="var(--color-info)" />
      <Cursor path="cs-path-c" color="var(--color-add)" />
    </div>
  );
}

function Bubble({ side, width, delay, color }: { side: "left" | "right"; width: string; delay: number; color?: string }) {
  return (
    <span
      className={cn("cs-bubble block h-2.5 rounded-full", side === "right" && "self-end", !color && "bg-veil-strong")}
      style={{ width, animationDelay: `${delay}s`, background: color ? `color-mix(in oklab, ${color} 55%, transparent)` : undefined } as CSSProperties}
    />
  );
}

/** A collaborator's pointer and, beside it, their colour as a blank name tag. */
function Cursor({ path, color }: { path: string; color: string }) {
  return (
    <span className={cn("cs-cursor absolute left-0 top-0 flex items-start", path)}>
      <svg width="14" height="14" viewBox="0 0 14 14" className="drop-shadow-sm">
        <path d="M1.5 1.5l10 4.2-4.3 1.4-1.5 4.4z" fill={color} stroke="white" strokeWidth="1" strokeLinejoin="round" />
      </svg>
      <span className="mt-3 h-2.5 w-6 rounded-full" style={{ background: color }} />
    </span>
  );
}
