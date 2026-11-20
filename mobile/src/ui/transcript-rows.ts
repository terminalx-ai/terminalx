import type { Token } from "marked";
import { callTarget, compactionStatus, type Delivery, type ToolCall, type Turn, type WorkItem } from "@terminalx/portable/transcript";
import { markdownBlocks, textChunks } from "./markdown-blocks";

/**
 * Where a message of the reader's is, said under it (design 22.03): `delivered`
 * once the Mac has it, a small tick; `queued` while it waits for the agent.
 * None when that is not known (delivery unconfirmed) or it was never sent.
 */
export type MessageDelivery = "delivered" | "queued";

export type TurnRow = { key: string; startsTurn: boolean; ts?: string } & (
  /** `note`: under the last of a message's rows, what became of it on its way to the agent (#722). */
  /** `images`: under the first of a message's rows, the images sent with it. */
  /** `delivery`: under the last of a message's rows, where the message is. */
  | { kind: "prompt"; text: string; note?: string; images?: { url: string; name?: string }[]; delivery?: MessageDelivery }
  | { kind: "markdown"; token: Token }
  | { kind: "work"; item: WorkItem }
  /** Consecutive tool calls, folded into one line ("Ran 2 commands") that opens to show each. */
  | { kind: "calls"; calls: ToolCall[] }
);

/** What became of a message of the reader's on its way to the agent, in a line (#722). */
export function deliveryNote(delivery: Delivery): string | undefined {
  if (delivery.replaced) return "Not answered: the agent dropped this turn before replying, and took a later prompt in its place.";
  if (delivery.unconfirmed) return "Delivery was not confirmed. Check the conversation before sending again.";
  if (delivery.withdrawn) return "Not sent: the agent was stopped before it took this message.";
  if (delivery.inputOccupied && delivery.inputChoice) return "Waiting: the agent is asking a question in its terminal. Answer it there, and this message goes in after.";
  if (delivery.inputOccupied) return "Waiting: the agent's input box already has text in it. Send or clear that text in the terminal, and this message goes in after it.";
  if (delivery.sent !== undefined) return "Changed on the way: this is what the agent received.";
  return undefined;
}

/**
 * Where a message in the transcript is. Being in the transcript at all means
 * the Mac recorded it; `waiting` is a message still queued for the agent.
 * - Unconfirmed: the acknowledgement was lost, so no tick is claimed.
 * - Withdrawn: it was never typed, so it is neither delivered nor waiting.
 * - Waiting on an occupied input box: still queued.
 */
export function messageDelivery(delivery: Delivery, waiting: boolean): MessageDelivery | undefined {
  if (delivery.unconfirmed || delivery.withdrawn) return undefined;
  if (waiting || delivery.inputOccupied) return "queued";
  return "delivered";
}

/** A call a run folds without losing anything: one an agent's safety check held, or that returned images, keeps a row of its own (#775). */
export function folds(call: ToolCall): boolean {
  return !call.result?.safetyCheck && !call.result?.images?.length;
}

const SHELL_NAMES = new Set(["Bash", "shell", "exec_command", "local_shell"]);
type CallKind = "command" | "read" | "edit" | "search" | "web" | "agent" | "plan" | "question" | "tool";
function callKind(call: ToolCall): CallKind {
  if (call.toolType === "shell" || SHELL_NAMES.has(call.name)) return "command";
  if (call.toolType === "file_read") return "read";
  if (call.toolType === "file_edit" || call.toolType === "file_write") return "edit";
  if (call.toolType === "search") return "search";
  if (call.toolType === "web") return "web";
  if (call.toolType === "subagent_spawn") return "agent";
  if (call.toolType === "plan") return "plan";
  if (call.toolType === "question") return "question";
  return "tool";
}

/** How a run of calls of one kind reads, past tense: [one, many]. */
const PHRASES: Record<CallKind, [string, (count: number) => string]> = {
  command: ["ran a command", (n) => `ran ${n} commands`],
  read: ["read a file", (n) => `read ${n} files`],
  edit: ["edited a file", (n) => `edited ${n} files`],
  search: ["searched once", (n) => `searched ${n} times`],
  web: ["looked something up on the web", (n) => `looked up ${n} things on the web`],
  agent: ["started an agent", (n) => `started ${n} agents`],
  plan: ["updated the plan", (n) => `updated the plan ${n} times`],
  question: ["asked a question", (n) => `asked ${n} questions`],
  tool: ["used a tool", (n) => `used ${n} tools`],
};

const capitalized = (text: string) => text ? text[0].toUpperCase() + text.slice(1) : text;

/**
 * The folded line for a run of calls: "Ran 2 commands", "Ran 2 commands, read
 * a file". Kinds keep the order the agent first used them in. A single call is
 * named in the agent's words (`callDescription`). A run whose last call is
 * still going says so; one the agent stopped says that.
 */
export function callsLabel(calls: readonly ToolCall[]): string {
  const counts = new Map<CallKind, number>();
  for (const call of calls) { const kind = callKind(call); counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  const said = calls.length === 1 ? callDescription(calls[0])
    : capitalized([...counts].map(([kind, count]) => count === 1 ? PHRASES[kind][0] : PHRASES[kind][1](count)).join(", "));
  const last = calls[calls.length - 1];
  if (!last) return said;
  if (last.abandoned) return `${said} · stopped`;
  if (!last.result) return `${said} · running`;
  return said;
}

const inputOf = (call: ToolCall): Record<string, unknown> => call.input && typeof call.input === "object" ? call.input as Record<string, unknown> : {};

/**
 * What a call ran, whole: a shell command (a Codex argv as the shell line it
 * runs), otherwise what it worked on, a path or pattern or URL. Undefined
 * when the call names nothing.
 */
export function callCommand(call: ToolCall): string | undefined {
  const command = inputOf(call).command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string") && command.length) {
    // `["bash", "-lc", "<line>"]` is how Codex runs a shell line: the line is the command.
    const shellLine = command.length === 3 && /(^|\/)(ba|z)?sh$/.test(command[0]) && /^-l?c$/.test(command[1]);
    return shellLine ? command[2] : command.join(" ");
  }
  return callTarget(call);
}

/**
 * The agent's plain words for a call: what it said the command does (Claude's
 * `description`) or why it ran it (Codex's `justification`), else the call's
 * title when that says more than the command does, else what kind of call it
 * was ("Ran a command").
 */
export function callDescription(call: ToolCall): string {
  const input = inputOf(call);
  for (const name of ["description", "justification"]) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const title = call.title?.trim();
  const command = callCommand(call);
  if (title && title !== command && title !== call.name) return title;
  return capitalized(PHRASES[callKind(call)][0]);
}

/** The first line of a command, and whether anything was left off it: what the folded-open row shows until tapped. */
export function commandFirstLine(command: string): { line: string; cut: boolean } {
  const trimmed = command.trim();
  const end = trimmed.indexOf("\n");
  return end === -1 ? { line: trimmed, cut: false } : { line: `${trimmed.slice(0, end).trimEnd()} …`, cut: true };
}

/** The calls in a run of work items: a run of one tool, which `groupWork` folded, counts call by call. */
const runCalls = (item: WorkItem): ToolCall[] | null => item.kind === "tool" ? [item.call] : item.kind === "tool_group" ? item.calls : null;

// A turn is a grouping for transcript semantics, not a virtualization unit.
// Give the list individual message blocks with stable keys during streaming,
// tool completion, reconnects, and insertion of earlier turns.
export function turnRows(turn: Turn): TurnRow[] {
  const rows: TurnRow[] = [];
  const addMarkdown = (key: string, text: string, ts?: string) => {
    for (const [index, token] of markdownBlocks(text).entries()) rows.push({ key: `${key}:${index}`, kind: "markdown", token, startsTurn: false, ts: index === 0 ? ts : undefined });
  };
  /** The reader's words, a row per chunk: images on the first, what became of it and where it is on the last. */
  const addMessage = (key: string, message: { text: string; messageTs?: string; images?: { url: string; name?: string }[] } & Delivery, waiting: boolean) => {
    const chunks = message.text ? textChunks(message.text) : [""];
    for (const [index, text] of chunks.entries()) rows.push({ key: `${key}:${index}`, kind: "prompt", text, startsTurn: false, ts: index === 0 ? message.messageTs : undefined, ...(index === 0 && message.images?.length ? { images: message.images } : {}) });
    const last = rows[rows.length - 1];
    if (last?.kind !== "prompt") return;
    const note = deliveryNote(message);
    if (note) last.note = note;
    const delivery = messageDelivery(message, waiting);
    if (delivery) last.delivery = delivery;
  };
  /** The run of calls being folded, until something that is not a call ends it. */
  let run: Extract<TurnRow, { kind: "calls" }> | null = null;
  if (turn.prompt) addMessage(`prompt:${turn.prompt.seq}`, turn.prompt, false);
  for (const item of turn.work) {
    const calls = runCalls(item);
    if (calls) {
      for (const call of calls) {
        if (!folds(call)) {
          // Drawn open, on its own: it ends the run before it, and nothing joins it.
          rows.push({ key: `calls:${call.callId}`, kind: "calls", calls: [call], startsTurn: false });
          run = null;
          continue;
        }
        // The run keeps its first call's key as it grows, so the row it already drew is not remounted.
        if (run) run.calls.push(call);
        else { run = { key: `calls:${call.callId}`, kind: "calls", calls: [call], startsTurn: false }; rows.push(run); }
      }
      continue;
    }
    // A compaction that runs has no row of its own: the conversation's "Compacting context…" line stands for it.
    if (item.kind === "compaction" && compactionStatus(item) === null) continue;
    run = null;
    if (item.kind === "text") addMarkdown(item.key, item.text, item.messageTs);
    // A message the agent took mid-turn, or one still queued for it, is the reader's, drawn like the prompt.
    else if (item.kind === "message") addMessage(item.key, item, false);
    else if (item.kind === "queued") addMessage(item.key, item, true);
    else if ("text" in item) {
      for (const [index, text] of textChunks(item.text).entries()) rows.push({ key: `${item.key}:${index}`, kind: "work", item: { ...item, text }, startsTurn: false });
    } else rows.push({ key: item.key, kind: "work", item, startsTurn: false });
  }
  if (turn.finalText) addMarkdown(`final:${turn.key}`, turn.finalText);
  if (rows.length) rows[0].startsTurn = true;
  return rows;
}
