import type { CompactionEvidence } from "./compactionLifecycle";
export type { CompactionEvidence, CompactionScope } from "./compactionLifecycle";

/**
 * Portable twin of src-tauri/src/events.rs. Field names are the serde wire
 * contract: payload `type` and enum values are snake_case, fields camelCase.
 */
export interface AgentEvent {
  id: string;
  sessionId: string;
  tabId: string;
  harness: string;
  seq: number;
  ts: string;
  /** Verified source/send time; legacy `ts` may only record when history was imported. */
  messageTs?: string;
  /** Correlates a recorded desktop Create prompt with its pending preview. */
  promptRequestId?: string;
  subagent?: SubagentRef;
  payload: Payload;
}

export interface SubagentRef {
  id: string;
  label?: string;
}

export interface BlockRef {
  messageId: string;
  index: number;
}

export interface ImageRef {
  url: string;
  mediaType?: string;
  name?: string;
}

/**
 * A file attached to a message (PRO-290), stored in the session's attachments
 * folder. `path` is absolute; the agent is handed it in the prompt it receives.
 */
export interface FileRef {
  path: string;
  name: string;
  mediaType?: string;
  size?: number;
}

export type ToolType =
  | "shell"
  | "file_read"
  | "file_edit"
  | "file_write"
  | "search"
  | "web"
  | "mcp"
  | "subagent_spawn"
  | "plan"
  | "question"
  | "other";

export interface ToolResult {
  text: string;
  isError: boolean;
  structured?: unknown;
  exitCode?: number;
  images?: ImageRef[];
  /** The agent's own safety check that held the call for a person, and what became of it: "Approved past Claude's dangerous-removal check" (#775). */
  safetyCheck?: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input is uncached; these cache counters are disjoint from it. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsed?: number;
  contextMax?: number;
  costUsd?: number;
  /** The full id of the model that produced this reading, when the agent says. */
  model?: string;
  /** The reasoning effort the turn ran at, when the agent's records say. */
  effort?: string;
  /** Whether the turn ran in the agent's fast mode, when its records say. */
  fast?: boolean;
}

export type TurnStatus = "ok" | "error" | "aborted";
export type EditKind = "update" | "create" | "delete" | "rename";

export interface FileEdit {
  path: string;
  oldText?: string;
  newText?: string;
  unified?: string;
  kind: EditKind;
}

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "allow_session"
  | "deny"
  | "switch_mode";

export interface PermissionOption {
  id: string;
  label: string;
  kind: PermissionOptionKind;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
  freeText: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface BackgroundTask {
  id: string;
  label?: string;
  kind?: string;
}

export type Delta =
  | { delta: "block_start"; block: BlockRef; blockType: string }
  | { delta: "text_delta"; block: BlockRef; text: string }
  | { delta: "thinking_delta"; block: BlockRef; text: string }
  | { delta: "input_delta"; block: BlockRef; partialJson: string }
  | { delta: "block_stop"; block: BlockRef };

export type RecoveryKind = "capacity" | "usage_limit" | "tool" | "timeout" | "delivery_unconfirmed" | "unsent" | "disconnected" | "permission_expired" | "signed_out" | "failed";

export interface HeldFollowUp { id: string; text: string; images: ImageRef[]; files?: FileRef[] }
export interface HeldQueue {
  items: HeldFollowUp[];
  paused: boolean;
  sending: string | null;
  next: string | null;
  error: string | null;
}

/** Reported by Codex; tokensUsed is goal usage, not context-window occupancy. */
export interface Goal {
  objective: string;
  status: "active" | "paused" | "complete" | "blocked" | "budgetLimited" | "usageLimited";
  tokenBudget: number | null;
  tokensUsed: number;
}

/**
 * A question the agent's CLI drew in its own terminal, which no hook reports
 * (PRO-460): Claude Code's "We recommend compacting earlier", say. `options`
 * is empty when something waits there that could not be read.
 */
export interface ScreenPrompt {
  /** Which question: answers name it, so they cannot land on another. */
  id: string;
  title?: string;
  text?: string;
  options: { label: string; description?: string }[];
  /** The option the CLI's pointer is on. */
  selected?: number;
  /** What Escape does, in the CLI's words ("Not now"), when it offers that. */
  dismiss?: string;
  /** The keys line the CLI draws under the options. */
  hint?: string;
}

export type Payload =
  | { type: "held_queue"; queue: HeldQueue }
  /** The agent's CLI is stopped on a question it drew itself (PRO-460); null once it is gone. */
  | { type: "terminal_prompt"; prompt: ScreenPrompt | null }
  | { type: "goal_updated"; goal: Goal }
  | { type: "goal_cleared" }
  | { type: "recovery"; kind: RecoveryKind | null }
  | { type: "turn_checkpoint"; seq: number; base: string; head: string }
  | { type: "turn_started"; model?: string; providerSessionId?: string; promptSeq?: number; startedBy?: string; initiatingPrompt?: string }
  | {
      type: "turn_completed";
      status: TurnStatus;
      finalText?: string;
      usage?: Usage;
      durationMs?: number;
      head?: string;
      /** The agent's provider refused its sign-in (#667). */
      authFailed: boolean;
      /** A failed turn's last line from the agent itself, when it exited before it ever worked: bounded and redacted by the runtime. */
      detail?: string;
    }
  | { type: "settings_changed"; model?: string; effort?: string; permissionMode?: string }
  | {
      type: "user_message";
      author?: { userId: string; displayName: string };
      /** What the message is, when TerminalX put it in a bot's chat (PRO-539). `text` stays what the agent was given. */
      bot?: BotMessage;
      text: string;
      images?: ImageRef[];
      /** Files attached to the message besides its images (PRO-290). */
      files?: FileRef[];
      baseline?: string;
      queued: boolean;
      cwd?: string;
    }
  /** The agent took the queued `user_message` at `promptSeq` while its turn was still running (#551). */
  | { type: "prompt_absorbed"; promptSeq: number }
  /**
   * The `user_message` at `promptSeq` waits to be typed: the agent's input box holds something else (#722). `occupied: false` once it went in.
   * `choice`: what is in the way is a question the agent drew in place of its box, a list of choices to answer in the terminal (PRO-462).
   */
  | { type: "input_occupied"; promptSeq: number; occupied: boolean; choice?: boolean }
  /** The agent dropped the turn of the `user_message` at `promptSeq` before answering it, and took another prompt in its place (#722). */
  | { type: "prompt_replaced"; promptSeq: number }
  /** The agent recorded the `user_message` at `promptSeq` as `text`, not as it was sent (#722). */
  | { type: "prompt_changed"; promptSeq: number; text: string }
  /** The agent received the `user_message` at `promptSeq` inside the prompt shown for the one at `intoSeq` (#722). */
  | { type: "prompt_joined"; promptSeq: number; intoSeq: number }
  /** Stopped while the `user_message` at `promptSeq` waited on the agent's input box: never typed (#722). */
  | { type: "prompt_withdrawn"; promptSeq: number; unconfirmed?: boolean }
  | { type: "assistant_text"; block?: BlockRef; text: string }
  | { type: "reasoning"; block?: BlockRef; text: string }
  | ({ type: "delta" } & Delta)
  | {
      type: "tool_call_started";
      callId: string;
      name: string;
      toolType: ToolType;
      input: unknown;
      title?: string;
    }
  | { type: "tool_call_completed"; callId: string; result: ToolResult }
  | { type: "file_edits"; callId?: string; edits: FileEdit[] }
  | { type: "subagent_started"; agentId: string; callId?: string; label?: string }
  | { type: "subagent_completed"; agentId: string; callId?: string; summary?: string }
  | { type: "background_tasks_changed"; tasks: BackgroundTask[] }
  | {
      type: "permission_requested";
      requestId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      /** Provider session directory; a tool's explicit workdir may differ. */
      cwd?: string;
      title?: string;
      /** The agent's own words about the call. Never why the card is up. */
      description?: string;
      /** Why the card is up, in TerminalX's words: in bypass mode, Claude Code's own safety check (#775). */
      reason?: string;
      options: PermissionOption[];
    }
  | { type: "questions_asked"; requestId: string; toolUseId: string; questions: Question[] }
  | {
      type: "permission_decided";
      requestId: string;
      toolUseId?: string;
      allowed: boolean;
      label: string;
      automatic: boolean;
    }
  | { type: "permission_denied"; toolName: string; toolUseId?: string; message: string }
  | { type: "model_request_started" }
  | ({ type: "usage_update" } & Usage)
  | { type: "context_compaction_started" }
  /** Additive scoped evidence. Only an admitted after-gates start is confirmed.
   * persisted=false reports append uncertainty, never restart-recoverable success. */
  | { type: "context_compaction_lifecycle"; evidence: CompactionEvidence; confirmedStart?: boolean; persisted: boolean }
  | { type: "context_compacted"; preTokens?: number; postTokens?: number }
  /** What the agent kept of the conversation the compaction before it folded away; never a prompt (#524). */
  | { type: "compaction_summary"; text: string }
  | { type: "api_retry"; attempt: number; maxRetries: number; reason?: string }
  | { type: "rate_limited"; status?: string; resetsAt?: number; window?: string; message?: string }
  /** `handoff`: the hand-off the line is about, when it is one of the lines hand-offs leave in their two chats (PRO-539). */
  | { type: "status"; text: string; handoff?: HandoffNote }
  /**
   * The tab's terminal changed hands (#437): the events from here to the next
   * marker belong to another of the tab's conversations. `id` is absent for
   * the conversation the tab began with.
   */
  | { type: "conversation"; id?: string; harness: string; resumed?: boolean }
  /** `detail`: what a launch that was refused said (Codex too old, not installed), bounded and redacted by the runtime (#667). */
  | { type: "error"; message: string; fatal: boolean; detail?: string }
  | { type: "unknown"; kind: string };

export type PayloadType = Payload["type"];

const sortedEventArrays = new WeakSet<readonly AgentEvent[]>();
const appendedFromEvents = new WeakMap<readonly AgentEvent[], readonly AgentEvent[]>();

function isStrictlyAscending(events: readonly AgentEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    if (events[i].seq <= events[i - 1].seq) return false;
  }
  return true;
}

/** True when `next` was built solely by strictly appending higher-`seq` events onto `previous`. */
export function isStrictEventAppend(previous: readonly AgentEvent[], next: readonly AgentEvent[]): boolean {
  if (previous === next) return true;
  if (next.length < previous.length) return false;
  let cursor: readonly AgentEvent[] | undefined = next;
  for (let hops = 0; hops < 64 && cursor; hops++) {
    const parent = appendedFromEvents.get(cursor);
    if (parent === previous) return true;
    cursor = parent;
  }
  return false;
}

/** Merge paged tails and live appends without duplicating or reordering sequence numbers. */
export function mergeAgentEvents(existing: readonly AgentEvent[], incoming: readonly AgentEvent[]): AgentEvent[] {
  const existingSorted = existing.length <= 1 || sortedEventArrays.has(existing);
  if (incoming.length === 0) {
    if (existing.length === 0) return [];
    if (existingSorted) return existing as AgentEvent[];
  }
  if (existingSorted && incoming.length > 0 && isStrictlyAscending(incoming)) {
    if (existing.length === 0) {
      const result = incoming.slice();
      sortedEventArrays.add(result);
      appendedFromEvents.set(result, existing);
      return result;
    }
    const lastExisting = existing[existing.length - 1];
    if (incoming[0].seq > lastExisting.seq) {
      const result = existing.concat(incoming);
      sortedEventArrays.add(result);
      appendedFromEvents.set(result, existing);
      return result;
    }
    if (incoming.length === 1 && incoming[0].seq === lastExisting.seq) {
      if (incoming[0] === lastExisting) return existing as AgentEvent[];
      const result = existing.slice();
      result[result.length - 1] = incoming[0];
      sortedEventArrays.add(result);
      return result;
    }
  }
  const bySequence = new Map(existing.map((event) => [event.seq, event]));
  for (const event of incoming) bySequence.set(event.seq, event);
  const result = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
  sortedEventArrays.add(result);
  return result;
}

/**
 * Whether an interrupt is still unanswered (#427). `interruptedAt` is the
 * sequence number of the newest event when the interrupt was sent; until a
 * turn has ended after it, the turn the interrupt was meant for is the one
 * still running, and the same control may offer the stop that ends the
 * agent's process.
 */
export function interruptUnanswered(events: readonly AgentEvent[], interruptedAt: number | null): boolean {
  return interruptedAt !== null && !events.some((event) => event.seq > interruptedAt && event.payload.type === "turn_completed");
}

/**
 * What a message TerminalX put in a bot's chat is (PRO-539, `events::BotMessage`): a hand-off, a tell or an answer from
 * another bot, a mention from GitHub, Linear or a chat app, or the app's own note. It rides on the `user_message` beside
 * the text the agent was given, so a card is drawn from these fields and never read back out of that text. A field
 * with nothing to say is absent.
 */
export type BotMessage = {
  /** `handoff`, `tell`, `answer`, `mention`, `stopped`, `failed`, `dropped` or `checkBack`; a newer runtime may send another. */
  kind: string;
  /** A bot's id, `owner` for the owner's own act in the window, `terminalx` for the app's own word, `person` for a mention. */
  from: string;
  /** The bot it went to, by id. */
  to: string;
  /** The two bots' names when it was sent. */
  fromName?: string;
  toName?: string;
  /** A tell up the reporting line: "status to", not "message to". */
  status?: boolean;
  /** The hand-off it is, answers or is about. */
  handoff?: number;
  /** How far down its chain that hand-off is, and how deep a chain may go. */
  depth?: number;
  maxDepth?: number;
  title?: string;
  /** The sender's own words: a hand-off's scope, a message, an answer, what a mention says. */
  body?: string;
  due?: string;
  /** The owner's own note, when they handed an item on. */
  note?: string;
  /** The bot whose words `title` and `body` are, when the owner handed its item on, and that item's number. */
  wordsOf?: string;
  fromItem?: number;
  /** The receiving bot's item for a hand-off. */
  item?: number;
  /** An answer that says the work could not be done. */
  failed?: boolean;
  /** What the sender was to the receiver: `lead`, `report`, `listed` or `pointed`. */
  relation?: string;
  /** The two bots' access when it was sent, as the bots' records name it. */
  fromAccess?: string;
  toAccess?: string;
  mention?: MentionSource;
};

/** Where a mention of a bot came from (`events::MentionSource`). */
export type MentionSource = {
  /** `github`, `linear`, `slack` or `telegram`. */
  service: string;
  by: string;
  /** The owner's own account wrote it. */
  owner?: boolean;
  /** The pull request, issue, channel or group, as the app labels it. Absent for a direct chat. */
  place?: string;
  direct?: boolean;
  /** The comment's address, when the service gives one. */
  url?: string;
  title?: string;
};

/** The hand-off a `status` line in a bot's chat is about, and what happened to it (`events::HandoffNote`). */
export type HandoffNote = {
  number: number;
  /** `handed`, `answered`, `couldNot`, `stopped`, `notStarted` or `failed`. */
  event: string;
  /** Whose chat the line is in: `from`, the bot that handed the work on, or `to`. */
  side: string;
  from: string;
  to: string;
  /** Who handed it: the sending bot's id, or `owner`. */
  by: string;
  /** The hand-off's title, in its sender's words. */
  title?: string;
};
