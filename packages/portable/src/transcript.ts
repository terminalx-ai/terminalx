import type { AgentEvent, BackgroundTask, FileEdit, Payload, PermissionOption, Question, ToolResult } from "./events";
import { withoutHarnessBlocks } from "./harnessText";
import { compactionOperationKey, emptyCompactionLifecycle, reduceCompactionLifecycle, type CompactionLifecycle, type CompactionOperation } from "./compactionLifecycle";

/** Turns an event log into the platform-neutral transcript model. */
export interface ToolCall {
  callId: string;
  name: string;
  toolType: string;
  input: unknown;
  title?: string;
  result?: ToolResult;
  edits?: FileEdit[];
  abandoned?: boolean;
  seq: number;
  subagent?: { id: string; label?: string };
}

/** How the cloud runtime's "this turn ended with the restart" notice begins (src-tauri `cloud_agents`). */
const RUNTIME_RESTARTED_NOTICE = "The workspace runtime restarted";

/**
 * How Claude Code begins a compaction's summary. Logs from before #524 hold
 * that summary as a prompt, straight after the compaction it belongs to.
 */
const COMPACTION_SUMMARY_OPENING = "This session is being continued from a previous conversation that ran out of context.";

/** What became of a message of the reader's on its way to the agent (#722). */
export interface Delivery {
  /** Not typed yet: the agent's input box holds something else. */
  inputOccupied?: boolean;
  /** The agent dropped its turn before answering it, and took another prompt in its place. */
  replaced?: boolean;
  /** What was sent, when the agent received something else; `text` is then what it received. */
  sent?: string;
}

export type WorkItem =
  | { kind: "tool"; call: ToolCall; key: string }
  | { kind: "tool_group"; name: string; calls: ToolCall[]; key: string }
  | { kind: "text"; text: string; key: string; seq: number; messageTs?: string }
  | { kind: "reasoning"; text: string; key: string; seq: number }
  | ({ kind: "queued"; author?: { userId: string; displayName: string }; text: string; key: string; seq: number; ts?: string; messageTs?: string; images?: { url: string; name?: string }[] } & Delivery)
  /** A queued message the agent took mid-turn (#551): the reader's own words, where the agent read them. */
  | ({ kind: "message"; author?: { userId: string; displayName: string }; text: string; key: string; seq: number; ts?: string; messageTs?: string; images?: { url: string; name?: string }[] } & Delivery)
  | { kind: "status"; text: string; initiatingPrompt?: string; key: string; seq: number }
  /** `detail`: the agent's (or its launch's) own words under the error (#667). */
  | { kind: "error"; text: string; detail?: string; key: string; seq: number }
  | { kind: "compaction"; preTokens?: number; postTokens?: number; summary?: string; lifecycle?: CompactionOperation; uncertain?: boolean; key: string; seq: number }
  | { kind: "retry"; attempt: number; maxRetries: number; reason?: string; key: string; seq: number }
  | { kind: "subagent"; agentId: string; label?: string; done: boolean; key: string; seq: number }
  | { kind: "decision"; label: string; allowed: boolean; automatic: boolean; key: string; seq: number };

export interface Turn {
  key: string;
  seq: number;
  /** Time of the event that opened this turn, even without a prompt or completion. */
  ts: string;
  prompt?: { author?: { userId: string; displayName: string }; text: string; images?: { url: string; name?: string }[]; ts: string; messageTs?: string; seq: number } & Delivery;
  work: WorkItem[];
  finalText?: string;
  /** Under a failed turn's `finalText`: the agent's last line, when it exited before it ever worked (#667). */
  detail?: string;
  completed?: { status: string; durationMs?: number; ts: string; head?: string };
  usage?: { contextUsed?: number; contextMax?: number };
  toolCount: number;
  editedFiles: number;
  live: boolean;
}

export interface PendingAsk {
  requestId: string;
  toolUseId: string;
  seq: number;
  kind: "permission" | "questions";
  toolName?: string;
  title?: string;
  description?: string;
  cwd?: string;
  input?: unknown;
  options?: PermissionOption[];
  questions?: Question[];
}

export interface Transcript {
  turns: Turn[];
  pendingAsks: PendingAsk[];
  tasks: BackgroundTask[];
  contextUsed?: number;
  contextMax?: number;
  /** The full id of the model the agent last said it ran; what an alias came to. */
  model?: string;
  compacting: boolean;
  retry?: { attempt: number; maxRetries: number; reason?: string };
  modelRequestOpen: boolean;
  workingSince?: number;
  authFailed: boolean;
  rateLimit?: { status?: string; resetsAt?: number; window?: string };
  usageWindows?: Record<string, { utilization: number; resetsAt: number }>;
  codexUsage?: { usedPercent: number; resetsAt: number; windowMins: number; plan?: string };
}

const GROUPABLE = new Set(["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "Bash", "shell", "apply_patch"]);
const EFFECTIVE_USER_PREFIX = "[TerminalX Effective User v1] ";

function visibleUserText(text: string): string {
  if (!text.startsWith(EFFECTIVE_USER_PREFIX)) return text;
  const lineEnd = text.indexOf("\n", EFFECTIVE_USER_PREFIX.length);
  if (lineEnd < 0) return text;
  try {
    const envelope = JSON.parse(text.slice(EFFECTIVE_USER_PREFIX.length, lineEnd)) as { authority?: unknown; userId?: unknown };
    if (envelope.authority === "host" && typeof envelope.userId === "string" && envelope.userId.length > 0) {
      return text.slice(lineEnd + 1);
    }
  } catch {
    // A user can type the prefix literally; only hide a structured envelope.
  }
  return text;
}

/** Lift the queued message published under `seq` out of the turn it is a note in, and say where it was. */
function pullQueued(turns: Turn[], seq: number): { item: Extract<WorkItem, { kind: "queued" }>; turn: Turn; at: number } | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const work = turns[index].work;
    const at = work.findIndex((item) => item.kind === "queued" && item.seq === seq);
    if (at < 0) continue;
    const [item] = work.splice(at, 1);
    return item.kind === "queued" ? { item, turn: turns[index], at } : undefined;
  }
  return undefined;
}

/**
 * Take a message out of where it was drawn, for the turn it was in fact the
 * prompt of; a `turn_started` naming its seq says so (the message itself is
 * published once, when it is sent). Returns it with the turn it came from.
 *
 * A queued message is a note in the turn it was queued behind: the agent held
 * it until that turn was over and then took it as its next prompt, or it was
 * typed again as one when the reader sent it now. One the agent took mid-turn
 * has a `prompt_absorbed` instead (#551), and stays in its turn as a message;
 * in a log from before that event it stays as it was sent.
 *
 * A message drawn as a turn's prompt can be taken too (#540). It was sent
 * while the agent was busy on a turn of its own that the app had not heard
 * of, and what the agent did before taking it was drawn under it.
 */
function takeMessage(turns: Turn[], seq: number): { prompt: NonNullable<Turn["prompt"]>; from: Turn } | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.prompt?.seq !== seq) continue;
    const prompt = turn.prompt;
    turn.prompt = undefined;
    return { prompt, from: turn };
  }
  const found = pullQueued(turns, seq);
  if (!found) return undefined;
  const { item, turn } = found;
  const { inputOccupied, replaced, sent } = item;
  return { prompt: { author: item.author, text: item.text, images: item.images, ts: item.ts ?? "", messageTs: item.messageTs, seq: item.seq, inputOccupied, replaced, sent }, from: turn };
}

/** Where the reader's message published under `seq` is drawn now: a turn's prompt (no `at`), or a note at `at` in a turn's work. */
function findMessage(turns: Turn[], seq: number): { turn: Turn; at?: number } | undefined {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.prompt?.seq === seq) return { turn };
    const at = turn.work.findIndex((work) => (work.kind === "queued" || work.kind === "message") && work.seq === seq);
    if (at >= 0) return { turn, at };
  }
  return undefined;
}

/** Whether an event belongs to `conversation`, given the conversation marker it comes under (`conversationEvents`). */
function inConversation(event: AgentEvent, under: string | null, conversation: string | null): boolean {
  if (event.payload.type === "conversation") return false;
  if (event.payload.type === "context_compaction_lifecycle") return event.payload.evidence.scope.conversationId === conversation;
  return under === conversation;
}

/**
 * The events of one of a tab's conversations (#437).
 *
 * A tab follows its terminal: when another agent is started there, or the
 * same agent on something new, the tab moves on to another conversation and
 * keeps the ones before. They share the tab's log, each after its own
 * `conversation` marker; `conversation` is the marker wanted, `null` for the
 * one the tab began with (whose events come before any marker). A
 * conversation that was left and picked up again is all of its stretches.
 *
 * Scoped lifecycle corrections can arrive after a later conversation's
 * marker. Their explicit scope takes precedence over positional membership.
 */
export function conversationEvents(events: AgentEvent[], conversation: string | null): AgentEvent[] {
  if (!events.some((event) => event.payload.type === "conversation" || event.payload.type === "context_compaction_lifecycle")) return conversation === null ? events : [];
  const own: AgentEvent[] = [];
  let under: string | null = null;
  for (const event of events) {
    if (event.payload.type === "conversation") under = event.payload.id ?? null;
    else if (inConversation(event, under, conversation)) own.push(event);
  }
  return own;
}

type CompactionRow = Extract<WorkItem, { kind: "compaction" }>;
type SubagentRow = Extract<WorkItem, { kind: "subagent" }>;

/** A turn as last handed out, and what it was built from. */
interface Shown {
  version: number;
  live: boolean;
  /** Its calls with no result were drawn as abandoned: nothing is running. */
  abandoned: boolean;
  /** Its compaction rows' lifecycles, as continuity left them, where they differ from the rows' own. */
  overrides: Map<CompactionRow, CompactionOperation> | undefined;
  turn: Turn;
}

const sameOverrides = (a: Map<CompactionRow, CompactionOperation> | undefined, b: Map<CompactionRow, CompactionOperation> | undefined) =>
  a === b || (!!a && !!b && a.size === b.size && [...a].every(([row, operation]) => b.get(row) === operation));

/**
 * A transcript kept up to date one event at a time (#727). `buildTranscript`
 * is this over a whole log.
 *
 * Fed only what was appended, a long conversation costs about as much per
 * event as a short one. A `snapshot` is immutable, and the next one reuses
 * every turn that nothing has changed since, so a memoised row for an
 * unchanged turn is not drawn again. A snapshot taken with nothing new is the
 * same object.
 */
export class TranscriptReducer {
  private readonly turns: Turn[] = [];
  private readonly asks = new Map<string, PendingAsk>();
  private readonly calls = new Map<string, ToolCall>();
  /** The calls in `calls` that have no result yet: what a new prompt or a turn's end abandons. */
  private readonly unresolved = new Set<ToolCall>();
  /** The turn whose work holds a call (a subagent's calls are in none). */
  private readonly callTurn = new Map<ToolCall, Turn>();
  private readonly subagents = new Map<string, { turn: Turn; item: SubagentRow }[]>();
  private readonly compactions = new Map<string, CompactionLifecycle>();
  private readonly compactionRows = new Map<string, CompactionRow>();
  private readonly rowTurn = new Map<CompactionRow, Turn>();
  private readonly resolutions = new WeakMap<CompactionLifecycle, CompactionLifecycle>();
  private tasks: BackgroundTask[] = [];
  private contextUsed: number | undefined;
  private contextMax: number | undefined;
  private model: string | undefined;
  private compacting = false;
  private retry: Transcript["retry"];
  private modelRequestOpen = false;
  private authFailed = false;
  private rateLimit: Transcript["rateLimit"];
  private usageWindows: Transcript["usageWindows"];
  private codexUsage: Transcript["codexUsage"];
  private workingSince: number | undefined;
  private current: Turn | null = null;
  private afterCompaction = false;

  /** Bumped by every event that changed anything; a turn's own count says when it last changed. */
  private version = 0;
  private readonly versions = new Map<Turn, number>();
  private readonly shown = new Map<Turn, Shown>();
  private asksVersion = 0;
  private pendingAsks: { version: number; asks: PendingAsk[] } | null = null;
  private last: { version: number; live: boolean; transcript: Transcript } | null = null;

  constructor(private readonly options: { conversationId?: string | null; compactionContinuityKnown?: boolean } = {}) {}

  /** A turn something has just changed: it is built again for the next snapshot. */
  private touch(turn: Turn) {
    this.versions.set(turn, this.version);
  }

  private touchCall(call: ToolCall) {
    const turn = this.callTurn.get(call);
    if (turn) this.touch(turn);
  }

  /**
   * What became of the reader's message under `seq` on its way to the agent
   * (#722), wherever it is drawn now. A snapshot already handed out holds the
   * message itself, so it is replaced rather than changed, and its turn is
   * built again.
   */
  private changeMessage(seq: number, change: (message: Delivery & { text: string }) => Delivery & { text?: string }) {
    const found = findMessage(this.turns, seq);
    if (!found) return;
    const { turn, at } = found;
    if (at === undefined) {
      const prompt = turn.prompt!;
      turn.prompt = { ...prompt, ...change(prompt) };
    } else {
      const item = turn.work[at] as Extract<WorkItem, { kind: "queued" | "message" }>;
      turn.work[at] = { ...item, ...change(item) };
    }
    this.touch(turn);
  }

  private ensureTurn(event: AgentEvent): Turn {
    if (!this.current) {
      this.current = { key: `t${event.seq}`, seq: event.seq, ts: event.ts, work: [], toolCount: 0, editedFiles: 0, live: false };
      this.turns.push(this.current);
    }
    this.touch(this.current);
    return this.current;
  }

  /** Every call still waiting for its result is given up on. */
  private abandonUnresolved() {
    for (const call of this.unresolved) {
      if (call.abandoned === true) continue;
      call.abandoned = true;
      this.touchCall(call);
    }
  }

  // A compaction's summary is drawn under the compaction it follows.
  private attachSummary(event: AgentEvent, summary: string) {
    const turn = this.ensureTurn(event);
    const compaction = [...turn.work].reverse().find((item) => item.kind === "compaction");
    if (compaction?.kind === "compaction" && compaction.summary === undefined) compaction.summary = summary;
    else turn.work.push({ kind: "compaction", summary, key: `k${event.seq}`, seq: event.seq });
  }

  private newTurn(event: AgentEvent, prompt?: Turn["prompt"]): Turn {
    const turn: Turn = { key: `t${event.seq}`, seq: event.seq, ts: event.ts, work: [], toolCount: 0, editedFiles: 0, live: false };
    if (prompt) turn.prompt = prompt;
    this.current = turn;
    this.turns.push(turn);
    this.touch(turn);
    return turn;
  }

  push(event: AgentEvent): void {
    this.version++;
    const payload: Payload = event.payload;
    const followsCompaction = this.afterCompaction;
    // The app may clear a standing recovery between the two as the summary is taken for a prompt.
    if (!event.subagent && payload.type !== "recovery") this.afterCompaction = payload.type === "context_compacted";
    switch (payload.type) {
      case "user_message": {
        if (followsCompaction && !payload.queued && !payload.author && payload.text.startsWith(COMPACTION_SUMMARY_OPENING)) {
          this.attachSummary(event, payload.text);
          break;
        }
        const text = withoutHarnessBlocks(visibleUserText(payload.text));
        if (!text.trim() && !payload.images?.length && text !== payload.text) break;
        // Queued behind the turn the agent is on, even one that has drawn
        // nothing yet: a turn the agent started itself is heard of before its
        // first record (#540), and the message is not that turn's prompt.
        if (payload.queued) {
          this.ensureTurn(event).work.push({ kind: "queued", author: payload.author, text, key: `q${event.seq}`, seq: event.seq, ts: event.ts, messageTs: event.messageTs, images: payload.images });
          break;
        }
        this.abandonUnresolved();
        this.newTurn(event, { author: payload.author, text, images: payload.images, ts: event.ts, messageTs: event.messageTs, seq: event.seq });
        this.modelRequestOpen = false;
        this.workingSince = Date.parse(event.ts);
        break;
      }
      case "turn_started": {
        // A turn the agent started itself (#540): nobody's prompt, and a line
        // saying what started it.
        if (payload.startedBy) {
          // Bare local commands often have no completion event. Their status
          // output is not the next scheduled turn's work (#566). A command
          // with model/tool work already underway still owns that work.
          const current = this.current;
          if (!this.modelRequestOpen && current?.prompt && current.prompt.text.startsWith("/") && !/[\r\n]/.test(current.prompt.text)
            && current.work.every((item) => item.kind === "status" || item.kind === "queued" || item.kind === "compaction")) {
            const waiting = current.work.filter((item) => item.kind === "queued");
            current.work = current.work.filter((item) => item.kind !== "queued");
            this.touch(current);
            this.current = null;
            this.ensureTurn(event).work.push(...waiting);
          }
          this.ensureTurn(event).work.push({ kind: "status", text: payload.startedBy, initiatingPrompt: payload.initiatingPrompt, key: `st${event.seq}`, seq: event.seq });
          this.modelRequestOpen = false;
          this.workingSince = Date.parse(event.ts);
        }
        if (payload.promptSeq == null) break;
        const taken = takeMessage(this.turns, payload.promptSeq);
        if (!taken) break;
        const { prompt, from } = taken;
        this.touch(from);
        // The open turn has no prompt yet, unless it is the one the message
        // came out of and the agent's earlier work stays there.
        const open = this.current;
        let current: Turn;
        if (open && !open.completed && !open.prompt && (open !== from || !open.work.length)) {
          open.prompt = prompt;
          this.touch(open);
          current = open;
        } else {
          this.abandonUnresolved();
          current = this.newTurn(event, prompt);
        }
        // What was queued after it waits behind this turn now (#551), where it
        // can still be sent now: the agent takes what it holds in order. One
        // queued before it and still a note was taken mid-turn in a log from
        // before `prompt_absorbed`, and stays in the turn that read it. A
        // turn stopped to send one now puts that one first, so all of what
        // it held waits.
        if (from !== current) {
          const stopped = from.completed?.status === "aborted";
          const waiting = (item: WorkItem) => item.kind === "queued" && (stopped || item.seq > prompt.seq);
          current.work.unshift(...from.work.filter(waiting));
          from.work = from.work.filter((item) => !waiting(item));
        }
        // A turn that only ever held the message goes with it.
        if (from !== current && !from.prompt && !from.work.length && !from.completed) {
          this.turns.splice(this.turns.indexOf(from), 1);
          this.versions.delete(from);
          this.shown.delete(from);
        }
        this.modelRequestOpen = false;
        this.workingSince = Date.parse(event.ts);
        break;
      }
      case "prompt_absorbed": {
        const found = pullQueued(this.turns, payload.promptSeq);
        if (!found) break;
        const { item, turn, at } = found;
        this.touch(turn);
        const message: WorkItem = { ...item, kind: "message", key: `m${item.seq}` };
        // Placed where the agent read it: what it did before then was not
        // its answer to it.
        const current = this.current;
        if (current && !current.completed) {
          current.work.push(message);
          this.touch(current);
        } else turn.work.splice(at, 0, message);
        break;
      }
      case "input_occupied": {
        this.changeMessage(payload.promptSeq, () => ({ inputOccupied: payload.occupied || undefined }));
        break;
      }
      case "prompt_replaced": {
        // Drawn where it was, never answered: what the agent took in its place has a message of its own.
        this.changeMessage(payload.promptSeq, () => ({ replaced: true }));
        break;
      }
      case "prompt_changed": {
        // One message, showing what the agent received; what was sent stays with it.
        this.changeMessage(payload.promptSeq, (message) => ({ sent: message.sent ?? message.text, text: withoutHarnessBlocks(visibleUserText(payload.text)) }));
        break;
      }
      case "assistant_text": {
        const turn = this.ensureTurn(event);
        if (payload.text.trim()) turn.work.push({ kind: "text", text: payload.text, key: `a${event.seq}`, seq: event.seq, messageTs: event.messageTs });
        this.modelRequestOpen = false;
        break;
      }
      case "reasoning": {
        const turn = this.ensureTurn(event);
        if (payload.text.trim()) turn.work.push({ kind: "reasoning", text: payload.text, key: `r${event.seq}`, seq: event.seq });
        break;
      }
      case "tool_call_started": {
        const turn = this.ensureTurn(event);
        const call: ToolCall = {
          callId: payload.callId,
          name: payload.name,
          toolType: payload.toolType,
          input: payload.input,
          title: payload.title,
          seq: event.seq,
          subagent: event.subagent,
        };
        // One id names one call: a second start replaces the first, which no later event reaches.
        const replaced = this.calls.get(payload.callId);
        if (replaced) this.unresolved.delete(replaced);
        this.calls.set(payload.callId, call);
        this.unresolved.add(call);
        if (!event.subagent) {
          turn.work.push({ kind: "tool", call, key: `c${payload.callId}` });
          this.callTurn.set(call, turn);
          turn.toolCount++;
          this.modelRequestOpen = false;
        }
        break;
      }
      case "tool_call_completed": {
        const call = this.calls.get(payload.callId);
        if (call) {
          call.result = payload.result;
          call.abandoned = false;
          if (call.result) this.unresolved.delete(call);
          else this.unresolved.add(call);
          this.touchCall(call);
        }
        break;
      }
      case "file_edits": {
        const call = payload.callId ? this.calls.get(payload.callId) : undefined;
        if (call) {
          call.edits = (call.edits ?? []).concat(payload.edits);
          this.touchCall(call);
        }
        if (this.current) {
          this.current.editedFiles += new Set(payload.edits.map((edit) => edit.path)).size;
          this.touch(this.current);
        }
        break;
      }
      case "turn_completed": {
        const turn = this.ensureTurn(event);
        this.abandonUnresolved();
        turn.completed = { status: payload.status, durationMs: payload.durationMs, ts: event.ts, head: payload.head };
        const lastText = [...turn.work].reverse().find((item) => item.kind === "text");
        if (payload.finalText && (!lastText || (lastText.kind === "text" && lastText.text.trim() !== payload.finalText.trim()))) {
          if (payload.status !== "ok") turn.finalText = payload.finalText;
          else if (!lastText) turn.work.push({ kind: "text", text: payload.finalText, key: `f${event.seq}`, seq: event.seq, messageTs: event.messageTs });
        }
        if (payload.status !== "ok" && payload.detail) turn.detail = payload.detail;
        if (payload.usage) {
          if (payload.usage.contextUsed != null) this.contextUsed = payload.usage.contextUsed;
          if (payload.usage.contextMax != null) this.contextMax = payload.usage.contextMax;
          turn.usage = { contextUsed: payload.usage.contextUsed, contextMax: payload.usage.contextMax };
        }
        if (payload.authFailed) this.authFailed = true;
        this.modelRequestOpen = false;
        this.compacting = false;
        this.retry = undefined;
        this.workingSince = undefined;
        this.current = null;
        break;
      }
      case "permission_requested":
        this.asks.set(payload.requestId, {
          requestId: payload.requestId,
          toolUseId: payload.toolUseId,
          seq: event.seq,
          kind: "permission",
          toolName: payload.toolName,
          title: payload.title,
          description: payload.description,
          cwd: payload.cwd,
          input: payload.input,
          options: payload.options,
        });
        this.asksVersion++;
        break;
      case "questions_asked":
        this.asks.set(payload.requestId, { requestId: payload.requestId, toolUseId: payload.toolUseId, seq: event.seq, kind: "questions", questions: payload.questions });
        this.asksVersion++;
        break;
      case "permission_decided":
        if (this.asks.delete(payload.requestId)) this.asksVersion++;
        if (this.current && !payload.automatic) {
          this.current.work.push({ kind: "decision", label: payload.label, allowed: payload.allowed, automatic: payload.automatic, key: `d${event.seq}`, seq: event.seq });
          this.touch(this.current);
        }
        break;
      case "permission_denied":
        break;
      case "subagent_started": {
        const turn = this.ensureTurn(event);
        const item: SubagentRow = { kind: "subagent", agentId: payload.agentId, label: payload.label, done: false, key: `s${payload.agentId}`, seq: event.seq };
        turn.work.push(item);
        const known = this.subagents.get(payload.agentId) ?? [];
        known.push({ turn, item });
        this.subagents.set(payload.agentId, known);
        break;
      }
      case "subagent_completed": {
        // The first row for it in each turn that has one.
        const marked = new Set<Turn>();
        for (const { turn, item } of this.subagents.get(payload.agentId) ?? []) {
          if (marked.has(turn)) continue;
          marked.add(turn);
          item.done = true;
          this.touch(turn);
        }
        break;
      }
      case "background_tasks_changed":
        this.tasks = payload.tasks;
        break;
      case "model_request_started":
        // A provider continuation can precede its prompt echo. Keep the
        // stopped turn historical while this new request is visibly active.
        this.ensureTurn(event);
        this.modelRequestOpen = true;
        break;
      case "usage_update":
        if (payload.contextUsed != null) this.contextUsed = payload.contextUsed;
        if (payload.contextMax != null) this.contextMax = payload.contextMax;
        if (payload.model) this.model = payload.model;
        break;
      case "context_compaction_started":
        // Old unscoped starts cannot establish owner/connection continuity.
        this.ensureTurn(event).work.push({ kind: "compaction", key: `k${event.seq}`, seq: event.seq,
          lifecycle: { turnId: "", itemId: event.id, state: "unknown", generation: null, retrying: false } });
        break;
      case "context_compaction_lifecycle": {
        const evidence = payload.evidence;
        const scope = evidence.scope;
        if (event.subagent || scope.subagentId !== null || scope.sessionId !== event.sessionId || scope.tabId !== event.tabId
          || scope.provider !== event.harness || scope.conversationId !== (this.options.conversationId ?? null)) break;
        if (evidence.type === "item_started" && (!payload.confirmedStart || !payload.persisted)) break;
        const scopeKey = JSON.stringify([scope.sessionId, scope.tabId, scope.conversationId, scope.provider, scope.threadId, scope.subagentId]);
        const previous = this.compactions.get(scopeKey) ?? emptyCompactionLifecycle(scope);
        // Append uncertainty is a loss of evidence, never an optimistic terminal.
        const admitted = !payload.persisted && previous.generation !== null
          ? { type: "continuity_lost" as const, scope, generation: previous.generation, reason: "disconnected" as const } : evidence;
        if (!payload.persisted && previous.generation === null) break;
        const next = reduceCompactionLifecycle(previous, admitted);
        this.compactions.set(scopeKey, next);
        if (payload.persisted && (evidence.type === "item_completed" || evidence.type === "completion_reconciled")) this.afterCompaction = true;
        for (const operation of Object.values(next.operations)) {
          const key = `${scopeKey}:${compactionOperationKey(operation)}`;
          let row = this.compactionRows.get(key);
          if (!row) {
            row = { kind: "compaction", key: `k${event.seq}:${key}`, seq: event.seq };
            const turn = this.ensureTurn(event);
            turn.work.push(row);
            this.compactionRows.set(key, row);
            this.rowTurn.set(row, turn);
          }
          row.lifecycle = operation;
          if (!payload.persisted && operation.state === "unknown") row.uncertain = true;
          const turn = this.rowTurn.get(row);
          if (turn) this.touch(turn);
        }
        break;
      }
      case "context_compacted": {
        this.compacting = false;
        if (payload.postTokens != null) this.contextUsed = payload.postTokens;
        const turn = this.ensureTurn(event);
        turn.work.push({ kind: "compaction", preTokens: payload.preTokens, postTokens: payload.postTokens, key: `k${event.seq}`, seq: event.seq });
        break;
      }
      case "compaction_summary":
        this.attachSummary(event, payload.text);
        break;
      case "api_retry":
        this.retry = { attempt: payload.attempt, maxRetries: payload.maxRetries, reason: payload.reason };
        break;
      case "rate_limited":
        this.rateLimit = { status: payload.status, resetsAt: payload.resetsAt, window: payload.window };
        // A warning changes nothing in the conversation; a refused request ended the turn.
        if (payload.status === "rejected" && payload.message) {
          const turn = this.ensureTurn(event);
          turn.work.push({ kind: "error", text: payload.message, key: `e${event.seq}`, seq: event.seq });
        }
        break;
      case "status":
        // Older apps persisted a readiness guess as a permanent transcript
        // warning. It never established whether the prompt was delivered;
        // the recovery state now owns that question, including on reload.
        if (payload.text === "The agent was slow to start; check that your message arrived.") break;
        if (payload.text.startsWith("rate_limit:")) {
          try {
            const parsed = JSON.parse(payload.text.slice("rate_limit:".length));
            if (parsed && typeof parsed === "object") this.usageWindows = parsed;
          } catch {
            // Ignore malformed optional usage metadata.
          }
        } else if (payload.text.startsWith("codex_rate_limit:")) {
          try {
            const parsed = JSON.parse(payload.text.slice("codex_rate_limit:".length));
            const primary = parsed?.primary;
            if (primary && typeof primary.usedPercent === "number") {
              this.codexUsage = { usedPercent: primary.usedPercent, resetsAt: primary.resetsAt, windowMins: primary.windowDurationMins, plan: parsed.planType };
            }
          } catch {
            // Ignore malformed optional usage metadata.
          }
        } else if (!payload.text.startsWith("tool_pending:")) {
          // A cloud runtime that restarted several times says so each time;
          // back to back, that notice is shown once. Every other notice,
          // local sessions' included, is shown as often as it was said.
          const turn = this.ensureTurn(event);
          const last = turn.work[turn.work.length - 1];
          if (payload.text.startsWith(RUNTIME_RESTARTED_NOTICE) && last?.kind === "status" && last.text === payload.text) break;
          turn.work.push({ kind: "status", text: payload.text, key: `st${event.seq}`, seq: event.seq });
        }
        break;
      case "error": {
        const turn = this.ensureTurn(event);
        turn.work.push({ kind: "error", text: payload.message, detail: payload.detail, key: `e${event.seq}`, seq: event.seq });
        break;
      }
      case "settings_changed":
      case "conversation":
      case "delta":
      case "unknown":
        break;
    }
  }

  /** A compaction's lifecycle as the reader may take it: a reader gap is uncertainty (see `snapshot`). */
  private resolved(state: CompactionLifecycle): CompactionLifecycle {
    if (this.options.compactionContinuityKnown === true || state.generation === null) return state;
    let resolved = this.resolutions.get(state);
    if (!resolved) {
      resolved = reduceCompactionLifecycle(state, { type: "continuity_lost", scope: state.scope, generation: state.generation, reason: "disconnected" });
      this.resolutions.set(state, resolved);
    }
    return resolved;
  }

  /** The turn as handed out: its rows grouped, its calls and changing rows copied, so nothing pushed later alters it. */
  private present(turn: Turn, live: boolean, abandoned: boolean, overrides: Map<CompactionRow, CompactionOperation> | undefined): Turn {
    const work = turn.work.map((item): WorkItem => {
      switch (item.kind) {
        case "tool": {
          const call = abandoned && this.unresolved.has(item.call) ? { ...item.call, abandoned: true } : { ...item.call };
          return { kind: "tool", call, key: item.key };
        }
        case "subagent":
          return { ...item };
        case "compaction": {
          const lifecycle = overrides?.get(item);
          return lifecycle ? { ...item, lifecycle } : { ...item };
        }
        default:
          return item;
      }
    });
    return { ...turn, work: groupWork(work), live };
  }

  /** The transcript as it stands, with `live` saying whether the tab is running a turn now. */
  snapshot(live: boolean): Transcript {
    if (this.last && this.last.version === this.version && this.last.live === live) return this.last.transcript;
    // A reader gap is uncertainty, not evidence that the backend stopped. A
    // subsequent reconciled history read can establish current ownership again.
    let compacting = this.compacting;
    const overrides = new Map<Turn, Map<CompactionRow, CompactionOperation>>();
    for (const [scopeKey, state] of this.compactions) {
      for (const operation of Object.values(this.resolved(state).operations)) {
        const row = this.compactionRows.get(`${scopeKey}:${compactionOperationKey(operation)}`);
        const turn = row && this.rowTurn.get(row);
        if (row && turn && row.lifecycle !== operation) {
          const rows = overrides.get(turn) ?? new Map<CompactionRow, CompactionOperation>();
          rows.set(row, operation);
          overrides.set(turn, rows);
        }
        if (operation.state === "item_started") compacting = true;
      }
    }
    // With nothing running, a call still waiting for its result never gets one.
    const abandoning = new Set<Turn>();
    if (!live) for (const call of this.unresolved) {
      const turn = this.callTurn.get(call);
      if (turn) abandoning.add(turn);
    }
    const lastTurn = this.turns[this.turns.length - 1];
    const turns = this.turns.map((turn) => {
      const isLive = live && turn === lastTurn && !turn.completed;
      const abandoned = abandoning.has(turn);
      const rows = overrides.get(turn);
      const version = this.versions.get(turn) ?? 0;
      const shown = this.shown.get(turn);
      if (shown && shown.version === version && shown.live === isLive && shown.abandoned === abandoned && sameOverrides(shown.overrides, rows)) return shown.turn;
      const presented = this.present(turn, isLive, abandoned, rows);
      this.shown.set(turn, { version, live: isLive, abandoned, overrides: rows, turn: presented });
      return presented;
    });
    if (!this.pendingAsks || this.pendingAsks.version !== this.asksVersion) {
      this.pendingAsks = { version: this.asksVersion, asks: [...this.asks.values()].sort((a, b) => a.seq - b.seq) };
    }
    const transcript: Transcript = {
      turns,
      pendingAsks: this.pendingAsks.asks,
      tasks: this.tasks,
      contextUsed: this.contextUsed,
      contextMax: this.contextMax,
      model: this.model,
      compacting,
      retry: this.retry,
      modelRequestOpen: live && this.modelRequestOpen,
      workingSince: live ? this.workingSince : undefined,
      authFailed: this.authFailed,
      rateLimit: this.rateLimit,
      usageWindows: this.usageWindows,
      codexUsage: this.codexUsage,
    };
    this.last = { version: this.version, live, transcript };
    return transcript;
  }
}

export function buildTranscript(events: AgentEvent[], live: boolean, options: { conversationId?: string | null; compactionContinuityKnown?: boolean } = {}): Transcript {
  const reducer = new TranscriptReducer(options);
  for (const event of events) reducer.push(event);
  return reducer.snapshot(live);
}

/**
 * One conversation of a tab's log as the log grows (#727): its events and
 * its transcript, built on from what was there before. A log that was
 * replaced rather than appended to (a history read merged into it) is read
 * again from the start.
 */
export class ConversationView {
  private source: AgentEvent[] | null = null;
  private consumed = 0;
  private lastSeen: AgentEvent | undefined;
  private under: string | null = null;
  private own: AgentEvent[] = [];
  private ownView: AgentEvent[] = [];
  private talked = new Set<string | null>();
  private talkedView: ReadonlySet<string | null> = new Set();
  private reducer: TranscriptReducer;

  /** `whole`: every event of the log is this conversation's, markers or not (a cloud tab's log, as `buildTranscript` reads it). */
  constructor(readonly conversation: string | null, readonly compactionContinuityKnown: boolean, readonly whole = false) {
    this.reducer = this.fresh();
  }

  private fresh() {
    return new TranscriptReducer(this.whole
      ? { compactionContinuityKnown: this.compactionContinuityKnown }
      : { conversationId: this.conversation, compactionContinuityKnown: this.compactionContinuityKnown });
  }

  /** Read what was appended to `events` since the last call. */
  update(events: AgentEvent[]): this {
    const appended = events === this.source && events.length >= this.consumed && (this.consumed === 0 || events[this.consumed - 1] === this.lastSeen);
    if (!appended) {
      this.source = events;
      this.consumed = 0;
      this.under = null;
      this.own = [];
      this.ownView = [];
      this.talked = new Set();
      this.talkedView = new Set();
      this.reducer = this.fresh();
    }
    const before = this.own.length;
    const talkedBefore = this.talked.size;
    for (let index = this.consumed; index < events.length; index++) {
      const event = events[index];
      if (event.payload.type === "conversation") this.under = event.payload.id ?? null;
      else if (event.payload.type === "user_message") this.talked.add(this.under);
      if (!this.whole && !inConversation(event, this.under, this.conversation)) continue;
      this.own.push(event);
      this.reducer.push(event);
    }
    this.consumed = events.length;
    this.lastSeen = events[events.length - 1];
    if (this.own.length !== before || !appended) this.ownView = this.own.slice();
    if (this.talked.size !== talkedBefore || !appended) this.talkedView = new Set(this.talked);
    return this;
  }

  /** This conversation's events (`conversationEvents`): the same array until one is added. */
  events(): AgentEvent[] {
    return this.ownView;
  }

  /** The conversations of the log, this one or not, with a message in them. */
  conversationsWithMessages(): ReadonlySet<string | null> {
    return this.talkedView;
  }

  transcript(live: boolean): Transcript {
    return this.reducer.snapshot(live);
  }
}

/** Runs of two or more consecutive calls to one groupable tool fold into one row. */
export function groupWork(items: WorkItem[]): WorkItem[] {
  const output: WorkItem[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (item.kind === "tool" && GROUPABLE.has(item.call.name) && !item.call.result?.images?.length) {
      let nextIndex = index + 1;
      const run: ToolCall[] = [item.call];
      while (nextIndex < items.length) {
        const next = items[nextIndex];
        if (next.kind === "tool" && next.call.name === item.call.name && !next.call.result?.images?.length) {
          run.push(next.call);
          nextIndex++;
        } else break;
      }
      if (run.length >= 2) {
        output.push({ kind: "tool_group", name: item.call.name, calls: run, key: `g${item.call.callId}` });
        index = nextIndex;
        continue;
      }
    }
    output.push(item);
    index++;
  }
  return output;
}

export function turnHasAnswer(turn: Turn): boolean {
  return turn.work.some((item) => item.kind === "text") || !!turn.finalText;
}

export function groupTargets(calls: ToolCall[]): string[] {
  const targets = new Set<string>();
  for (const call of calls) {
    const target = callTarget(call);
    if (target) targets.add(target);
  }
  return [...targets];
}

export function callTarget(call: ToolCall): string | undefined {
  const input = (call.input ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "path", "notebook_path", "pattern", "command", "query", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Local display of an authoritative event time. Unzoned/invalid legacy values are unknown. */
export function messageTime(ts?: string, locales?: string, timeZone?: string): { short: string; full: string; iso: string } | undefined {
  if (!ts || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(ts)) return undefined;
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return undefined;
  return {
    short: new Intl.DateTimeFormat(locales, { timeStyle: "short", timeZone }).format(date),
    full: new Intl.DateTimeFormat(locales, { dateStyle: "full", timeStyle: "long", timeZone }).format(date),
    iso: date.toISOString(),
  };
}
