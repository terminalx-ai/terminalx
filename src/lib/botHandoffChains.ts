import { handoffOpen } from "@/lib/botHandoffs";
import type { Handoff } from "@/types/botHandoffs";

/**
 * Chains of hand-offs, for the Hand-offs page (PRO-540, design 23.16). A chain is the tree over what each hand-off
 * recorded when it was made: `parent`, the hand-off it was handed on from, and `retryOf`, the failed one it tries
 * again. Nothing else joins two hand-offs: not their bots, their chats, their times or their `depth`. `depth` is what
 * the limit counts (the deepest open hand-off its sender held, whatever chat it was sent from), so a hand-off with a
 * depth above 1 and no recorded parent is its own chain, and still says its depth.
 */

/** One hand-off in its chain. `level` is how many hand-offs deeper than the chain's first it sits: a retry sits where the one it tries again does. */
export interface ChainStep {
  handoff: Handoff;
  level: number;
}

export interface HandoffChain {
  /** Its first hand-off's number: what names the chain. */
  root: number;
  /** In the order they were made. */
  steps: ChainStep[];
  /** The first hand-off's title. */
  title: string;
  /** The bots it passed through, each once, in the order they came into it. */
  bots: string[];
  /** Some hand-off in it is not finished. */
  open: boolean;
  /** The deepest `depth` any of its hand-offs recorded: what the limit counted. */
  depth: number;
  started: string;
  /** The hand-off whose state stands for the chain in the list: one being worked on, else one still open, else its last first-level one. */
  lead: Handoff;
}

/**
 * The link a hand-off recorded, when the hand-off it names is among `known` and was made before it: a retry's is the
 * one it tries again, else its parent. A link to a record that is gone (trimmed, or unreadable here) joins nothing.
 */
function linkOf(handoff: Handoff, known: Map<number, Handoff>): { to: number; retry: boolean } | null {
  for (const [to, retry] of [[handoff.retryOf, true], [handoff.parent, false]] as const) {
    if (typeof to === "number" && to < handoff.number && known.has(to)) return { to, retry };
  }
  return null;
}

/** Every chain among `handoffs`: the open ones' newest first, as are the closed ones'. */
export function handoffChains(handoffs: readonly Handoff[]): HandoffChain[] {
  const known = new Map(handoffs.map((handoff) => [handoff.number, handoff]));
  const ordered = [...known.values()].sort((a, b) => a.number - b.number);
  // A link only ever names an earlier hand-off, so one pass in order places each after what it hangs from.
  const placed = new Map<number, { root: number; level: number }>();
  const groups = new Map<number, ChainStep[]>();
  for (const handoff of ordered) {
    const link = linkOf(handoff, known);
    const above = link ? placed.get(link.to) : undefined;
    const place = link && above ? { root: above.root, level: above.level + (link.retry ? 0 : 1) } : { root: handoff.number, level: 0 };
    placed.set(handoff.number, place);
    groups.set(place.root, [...(groups.get(place.root) ?? []), { handoff, level: place.level }]);
  }
  const chains = [...groups.entries()].map(([root, steps]): HandoffChain => {
    const first = steps[0].handoff;
    const bots: string[] = [];
    for (const { handoff } of steps) for (const id of [handoff.from, handoff.to]) if (!bots.includes(id)) bots.push(id);
    const open = steps.filter((step) => handoffOpen(step.handoff)).map((step) => step.handoff);
    const top = steps.filter((step) => step.level === 0).map((step) => step.handoff);
    return {
      root,
      steps,
      title: first.title,
      bots,
      open: open.length > 0,
      depth: Math.max(...steps.map((step) => Math.max(1, step.handoff.depth || 1))),
      started: first.created,
      lead: open.find((handoff) => handoff.state === "working") ?? open[0] ?? top[top.length - 1],
    };
  });
  const newest = (chain: HandoffChain) => chain.steps[chain.steps.length - 1].handoff.number;
  return chains.sort((a, b) => Number(b.open) - Number(a.open) || newest(b) - newest(a));
}

/** The chain that holds hand-off `number`. */
export function chainOf(chains: readonly HandoffChain[], number: number): HandoffChain | null {
  return chains.find((chain) => chain.steps.some((step) => step.handoff.number === number)) ?? null;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** A step's own time: "2:49 PM" today, "Nov 21, 2:49 PM" before. */
export function stepTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay(at, new Date(now)) ? time : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

/** When, as a chain's line in the list ends: "2:49 PM" today, "yesterday", "on Friday" this week, "on Nov 12" before. */
export function chainWhen(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = new Date(now);
  if (sameDay(at, today)) return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return `on ${at.toLocaleDateString([], { weekday: "long" })}`;
  return `on ${at.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

/** How a finished hand-off ended, in the middle of a sentence: "answered", "stopped by you", "could not be done". */
function endedWord(handoff: Handoff): string {
  switch (handoff.state) {
    case "answered":
      return "answered";
    case "stopped":
      return handoff.stoppedBy === "owner" ? "stopped by you" : "stopped";
    case "failed":
      return handoff.answer?.by === "terminalx" ? "not started" : "could not be done";
    default:
      return handoff.state;
  }
}

/** Under a chain's title in the list: "4 hand-offs · 3 deep · started 2:49 PM", or "1 hand-off · answered yesterday". */
export function chainLine(chain: HandoffChain, now = Date.now()): string {
  const count = chain.steps.length === 1 ? "1 hand-off" : `${chain.steps.length} hand-offs`;
  if (chain.open) return [count, `${chain.depth} deep`, `started ${chainWhen(chain.started, now)}`.trim()].join(" · ");
  const ended = `${endedWord(chain.lead)} ${chainWhen(chain.lead.closed ?? chain.lead.modified, now)}`.trim();
  return `${count} · ${ended}`;
}
