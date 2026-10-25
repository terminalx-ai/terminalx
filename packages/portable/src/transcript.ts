import type { AgentEvent, BackgroundTask, FileEdit, Payload, PermissionOption, Question, ToolResult } from "./events";
import { withoutHarnessBlocks } from "./harnessText";

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

export type WorkItem =
  | { kind: "tool"; call: ToolCall; key: string }
  | { kind: "tool_group"; name: string; calls: ToolCall[]; key: string }
  | { kind: "text"; text: string; key: string; seq: number; messageTs?: string }
  | { kind: "reasoning"; text: string; key: string; seq: number }
  | { kind: "queued"; author?: { userId: string; displayName: string }; text: string; key: string; seq: number; ts?: string; messageTs?: string; images?: { url: string; name?: string }[] }
  /** A queued message the agent took mid-turn (#551): the reader's own words, where the agent read them. */
  | { kind: "message"; author?: { userId: string; displayName: string }; text: string; key: string; seq: number; ts?: string; messageTs?: string; images?: { url: string; name?: string }[] }
  | { kind: "status"; text: string; initiatingPrompt?: string; key: string; seq: number }
  | { kind: "error"; text: string; key: string; seq: number }
  | { kind: "compaction"; preTokens?: number; postTokens?: number; summary?: string; key: string; seq: number }
  | { kind: "retry"; attempt: number; maxRetries: number; reason?: string; key: string; seq: number }
  | { kind: "subagent"; agentId: string; label?: string; done: boolean; key: string; seq: number }
  | { kind: "decision"; label: string; allowed: boolean; automatic: boolean; key: string; seq: number };

export interface Turn {
  key: string;
  seq: number;
  /** Time of the event that opened this turn, even without a prompt or completion. */
  ts: string;
  prompt?: { author?: { userId: string; displayName: string }; text: string; images?: { url: string; name?: string }[]; ts: string; messageTs?: string; seq: number };
  work: WorkItem[];
  finalText?: string;
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
  return { prompt: { author: item.author, text: item.text, images: item.images, ts: item.ts ?? "", messageTs: item.messageTs, seq: item.seq }, from: turn };
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
 * A log with no marker is one conversation and is returned as it is, so a
 * tab that never changed hands costs nothing here.
 */
export function conversationEvents(events: AgentEvent[], conversation: string | null): AgentEvent[] {
  if (!events.some((event) => event.payload.type === "conversation")) return conversation === null ? events : [];
  const own: AgentEvent[] = [];
  let under: string | null = null;
  for (const event of events) {
    if (event.payload.type === "conversation") under = event.payload.id ?? null;
    else if (under === conversation) own.push(event);
  }
  return own;
}

export function buildTranscript(events: AgentEvent[], live: boolean): Transcript {
  const turns: Turn[] = [];
  const asks = new Map<string, PendingAsk>();
  const calls = new Map<string, ToolCall>();
  let tasks: BackgroundTask[] = [];
  let contextUsed: number | undefined;
  let contextMax: number | undefined;
  let model: string | undefined;
  let compacting = false;
  let retry: Transcript["retry"];
  let modelRequestOpen = false;
  let authFailed = false;
  let rateLimit: Transcript["rateLimit"];
  let usageWindows: Transcript["usageWindows"];
  let codexUsage: Transcript["codexUsage"];
  let workingSince: number | undefined;

  let current: Turn | null = null;
  const ensureTurn = (event: AgentEvent) => {
    if (!current) {
      current = { key: `t${event.seq}`, seq: event.seq, ts: event.ts, work: [], toolCount: 0, editedFiles: 0, live: false };
      turns.push(current);
    }
    return current;
  };
  // A compaction's summary is drawn under the compaction it follows.
  const attachSummary = (event: AgentEvent, summary: string) => {
    const turn = ensureTurn(event);
    const compaction = [...turn.work].reverse().find((item) => item.kind === "compaction");
    if (compaction?.kind === "compaction" && compaction.summary === undefined) compaction.summary = summary;
    else turn.work.push({ kind: "compaction", summary, key: `k${event.seq}`, seq: event.seq });
  };
  let afterCompaction = false;

  for (const event of events) {
    const payload: Payload = event.payload;
    const followsCompaction = afterCompaction;
    // The app may clear a standing recovery between the two as the summary is taken for a prompt.
    if (!event.subagent && payload.type !== "recovery") afterCompaction = payload.type === "context_compacted";
    switch (payload.type) {
      case "user_message": {
        if (followsCompaction && !payload.queued && !payload.author && payload.text.startsWith(COMPACTION_SUMMARY_OPENING)) {
          attachSummary(event, payload.text);
          break;
        }
        const text = withoutHarnessBlocks(visibleUserText(payload.text));
        if (!text.trim() && !payload.images?.length && text !== payload.text) break;
        // Queued behind the turn the agent is on, even one that has drawn
        // nothing yet: a turn the agent started itself is heard of before its
        // first record (#540), and the message is not that turn's prompt.
        if (payload.queued) {
          ensureTurn(event).work.push({ kind: "queued", author: payload.author, text, key: `q${event.seq}`, seq: event.seq, ts: event.ts, messageTs: event.messageTs, images: payload.images });
          break;
        }
        for (const call of calls.values()) if (!call.result) call.abandoned = true;
        current = {
          key: `t${event.seq}`,
          seq: event.seq,
          ts: event.ts,
          prompt: { author: payload.author, text, images: payload.images, ts: event.ts, messageTs: event.messageTs, seq: event.seq },
          work: [],
          toolCount: 0,
          editedFiles: 0,
          live: false,
        };
        turns.push(current);
        modelRequestOpen = false;
        workingSince = Date.parse(event.ts);
        break;
      }
      case "turn_started": {
        // A turn the agent started itself (#540): nobody's prompt, and a line
        // saying what started it.
        if (payload.startedBy) {
          // Bare local commands often have no completion event. Their status
          // output is not the next scheduled turn's work (#566). A command
          // with model/tool work already underway still owns that work.
          if (!modelRequestOpen && current?.prompt && current.prompt.text.startsWith("/") && !/[\r\n]/.test(current.prompt.text)
            && current.work.every((item) => item.kind === "status" || item.kind === "queued" || item.kind === "compaction")) {
            const waiting = current.work.filter((item) => item.kind === "queued");
            current.work = current.work.filter((item) => item.kind !== "queued");
            current = null;
            ensureTurn(event).work.push(...waiting);
          }
          ensureTurn(event).work.push({ kind: "status", text: payload.startedBy, initiatingPrompt: payload.initiatingPrompt, key: `st${event.seq}`, seq: event.seq });
          modelRequestOpen = false;
          workingSince = Date.parse(event.ts);
        }
        if (payload.promptSeq == null) break;
        const taken = takeMessage(turns, payload.promptSeq);
        if (!taken) break;
        const { prompt, from } = taken;
        // The open turn has no prompt yet, unless it is the one the message
        // came out of and the agent's earlier work stays there.
        if (current && !current.completed && !current.prompt && (current !== from || !current.work.length)) {
          current.prompt = prompt;
        } else {
          for (const call of calls.values()) if (!call.result) call.abandoned = true;
          current = { key: `t${event.seq}`, seq: event.seq, ts: event.ts, prompt, work: [], toolCount: 0, editedFiles: 0, live: false };
          turns.push(current);
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
        if (from !== current && !from.prompt && !from.work.length && !from.completed) turns.splice(turns.indexOf(from), 1);
        modelRequestOpen = false;
        workingSince = Date.parse(event.ts);
        break;
      }
      case "prompt_absorbed": {
        const found = pullQueued(turns, payload.promptSeq);
        if (!found) break;
        const { item, turn, at } = found;
        const message: WorkItem = { ...item, kind: "message", key: `m${item.seq}` };
        // Placed where the agent read it: what it did before then was not
        // its answer to it.
        if (current && !current.completed) current.work.push(message);
        else turn.work.splice(at, 0, message);
        break;
      }
      case "assistant_text": {
        const turn = ensureTurn(event);
        if (payload.text.trim()) turn.work.push({ kind: "text", text: payload.text, key: `a${event.seq}`, seq: event.seq, messageTs: event.messageTs });
        modelRequestOpen = false;
        break;
      }
      case "reasoning": {
        const turn = ensureTurn(event);
        if (payload.text.trim()) turn.work.push({ kind: "reasoning", text: payload.text, key: `r${event.seq}`, seq: event.seq });
        break;
      }
      case "tool_call_started": {
        const turn = ensureTurn(event);
        const call: ToolCall = {
          callId: payload.callId,
          name: payload.name,
          toolType: payload.toolType,
          input: payload.input,
          title: payload.title,
          seq: event.seq,
          subagent: event.subagent,
        };
        calls.set(payload.callId, call);
        if (!event.subagent) {
          turn.work.push({ kind: "tool", call, key: `c${payload.callId}` });
          turn.toolCount++;
          modelRequestOpen = false;
        }
        break;
      }
      case "tool_call_completed": {
        const call = calls.get(payload.callId);
        if (call) {
          call.result = payload.result;
          call.abandoned = false;
        }
        break;
      }
      case "file_edits": {
        const call = payload.callId ? calls.get(payload.callId) : undefined;
        if (call) call.edits = (call.edits ?? []).concat(payload.edits);
        if (current) current.editedFiles += new Set(payload.edits.map((edit) => edit.path)).size;
        break;
      }
      case "turn_completed": {
        const turn = ensureTurn(event);
        for (const call of calls.values()) if (!call.result) call.abandoned = true;
        turn.completed = { status: payload.status, durationMs: payload.durationMs, ts: event.ts, head: payload.head };
        const lastText = [...turn.work].reverse().find((item) => item.kind === "text");
        if (payload.finalText && (!lastText || (lastText.kind === "text" && lastText.text.trim() !== payload.finalText.trim()))) {
          if (payload.status !== "ok") turn.finalText = payload.finalText;
          else if (!lastText) turn.work.push({ kind: "text", text: payload.finalText, key: `f${event.seq}`, seq: event.seq, messageTs: event.messageTs });
        }
        if (payload.usage) {
          if (payload.usage.contextUsed != null) contextUsed = payload.usage.contextUsed;
          if (payload.usage.contextMax != null) contextMax = payload.usage.contextMax;
          turn.usage = { contextUsed: payload.usage.contextUsed, contextMax: payload.usage.contextMax };
        }
        if (payload.authFailed) authFailed = true;
        modelRequestOpen = false;
        compacting = false;
        retry = undefined;
        workingSince = undefined;
        current = null;
        break;
      }
      case "permission_requested":
        asks.set(payload.requestId, {
          requestId: payload.requestId,
          toolUseId: payload.toolUseId,
          seq: event.seq,
          kind: "permission",
          toolName: payload.toolName,
          title: payload.title,
          description: payload.description,
          input: payload.input,
          options: payload.options,
        });
        break;
      case "questions_asked":
        asks.set(payload.requestId, { requestId: payload.requestId, toolUseId: payload.toolUseId, seq: event.seq, kind: "questions", questions: payload.questions });
        break;
      case "permission_decided":
        asks.delete(payload.requestId);
        if (current && !payload.automatic) {
          current.work.push({ kind: "decision", label: payload.label, allowed: payload.allowed, automatic: payload.automatic, key: `d${event.seq}`, seq: event.seq });
        }
        break;
      case "permission_denied":
        break;
      case "subagent_started": {
        const turn = ensureTurn(event);
        turn.work.push({ kind: "subagent", agentId: payload.agentId, label: payload.label, done: false, key: `s${payload.agentId}`, seq: event.seq });
        break;
      }
      case "subagent_completed":
        for (const turn of turns) {
          const item = turn.work.find((work) => work.kind === "subagent" && work.agentId === payload.agentId);
          if (item && item.kind === "subagent") item.done = true;
        }
        break;
      case "background_tasks_changed":
        tasks = payload.tasks;
        break;
      case "model_request_started":
        // A provider continuation can precede its prompt echo. Keep the
        // stopped turn historical while this new request is visibly active.
        ensureTurn(event);
        modelRequestOpen = true;
        break;
      case "usage_update":
        if (payload.contextUsed != null) contextUsed = payload.contextUsed;
        if (payload.contextMax != null) contextMax = payload.contextMax;
        if (payload.model) model = payload.model;
        break;
      case "context_compaction_started":
        compacting = true;
        break;
      case "context_compacted": {
        compacting = false;
        if (payload.postTokens != null) contextUsed = payload.postTokens;
        const turn = ensureTurn(event);
        turn.work.push({ kind: "compaction", preTokens: payload.preTokens, postTokens: payload.postTokens, key: `k${event.seq}`, seq: event.seq });
        break;
      }
      case "compaction_summary":
        attachSummary(event, payload.text);
        break;
      case "api_retry":
        retry = { attempt: payload.attempt, maxRetries: payload.maxRetries, reason: payload.reason };
        break;
      case "rate_limited":
        rateLimit = { status: payload.status, resetsAt: payload.resetsAt, window: payload.window };
        // A warning changes nothing in the conversation; a refused request ended the turn.
        if (payload.status === "rejected" && payload.message) {
          const turn = ensureTurn(event);
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
            if (parsed && typeof parsed === "object") usageWindows = parsed;
          } catch {
            // Ignore malformed optional usage metadata.
          }
        } else if (payload.text.startsWith("codex_rate_limit:")) {
          try {
            const parsed = JSON.parse(payload.text.slice("codex_rate_limit:".length));
            const primary = parsed?.primary;
            if (primary && typeof primary.usedPercent === "number") {
              codexUsage = { usedPercent: primary.usedPercent, resetsAt: primary.resetsAt, windowMins: primary.windowDurationMins, plan: parsed.planType };
            }
          } catch {
            // Ignore malformed optional usage metadata.
          }
        } else if (!payload.text.startsWith("tool_pending:")) {
          const turn = ensureTurn(event);
          // A cloud runtime that restarted several times says so each time;
          // back to back, that notice is shown once. Every other notice,
          // local sessions' included, is shown as often as it was said.
          const last = turn.work[turn.work.length - 1];
          if (payload.text.startsWith(RUNTIME_RESTARTED_NOTICE) && last?.kind === "status" && last.text === payload.text) break;
          turn.work.push({ kind: "status", text: payload.text, key: `st${event.seq}`, seq: event.seq });
        }
        break;
      case "error": {
        const turn = ensureTurn(event);
        turn.work.push({ kind: "error", text: payload.message, key: `e${event.seq}`, seq: event.seq });
        break;
      }
      case "settings_changed":
      case "conversation":
      case "delta":
      case "unknown":
        break;
    }
  }

  if (!live) for (const call of calls.values()) if (!call.result) call.abandoned = true;
  const last = turns[turns.length - 1];
  if (last && !last.completed && live) last.live = true;
  if (!live) {
    modelRequestOpen = false;
    workingSince = undefined;
  }

  for (const turn of turns) turn.work = groupWork(turn.work);

  return {
    turns,
    pendingAsks: [...asks.values()].sort((a, b) => a.seq - b.seq),
    tasks,
    contextUsed,
    contextMax,
    model,
    compacting,
    retry,
    modelRequestOpen,
    workingSince,
    authFailed,
    rateLimit,
    usageWindows,
    codexUsage,
  };
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
