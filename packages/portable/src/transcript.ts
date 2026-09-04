import type { AgentEvent, BackgroundTask, FileEdit, Payload, PermissionOption, Question, ToolResult } from "./events";

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

export type WorkItem =
  | { kind: "tool"; call: ToolCall; key: string }
  | { kind: "tool_group"; name: string; calls: ToolCall[]; key: string }
  | { kind: "text"; text: string; key: string; seq: number }
  | { kind: "reasoning"; text: string; key: string; seq: number }
  | { kind: "queued"; text: string; key: string; seq: number; images?: { url: string }[] }
  | { kind: "status"; text: string; key: string; seq: number }
  | { kind: "error"; text: string; key: string; seq: number }
  | { kind: "compaction"; preTokens?: number; postTokens?: number; key: string; seq: number }
  | { kind: "retry"; attempt: number; maxRetries: number; reason?: string; key: string; seq: number }
  | { kind: "subagent"; agentId: string; label?: string; done: boolean; key: string; seq: number }
  | { kind: "decision"; label: string; allowed: boolean; automatic: boolean; key: string; seq: number };

export interface Turn {
  key: string;
  seq: number;
  prompt?: { text: string; images?: { url: string }[]; ts: string; seq: number };
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
  compacting: boolean;
  retry?: { attempt: number; maxRetries: number; reason?: string };
  modelRequestOpen: boolean;
  workingSince?: number;
  authFailed: boolean;
  rateLimit?: { status?: string; resetsAt?: number };
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

export function buildTranscript(events: AgentEvent[], live: boolean): Transcript {
  const turns: Turn[] = [];
  const asks = new Map<string, PendingAsk>();
  const calls = new Map<string, ToolCall>();
  let tasks: BackgroundTask[] = [];
  let contextUsed: number | undefined;
  let contextMax: number | undefined;
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
      current = { key: `t${event.seq}`, seq: event.seq, work: [], toolCount: 0, editedFiles: 0, live: false };
      turns.push(current);
    }
    return current;
  };

  for (const event of events) {
    const payload: Payload = event.payload;
    switch (payload.type) {
      case "user_message": {
        const text = visibleUserText(payload.text);
        if (payload.queued && current && !current.completed) {
          current.work.push({ kind: "queued", text, key: `q${event.seq}`, seq: event.seq, images: payload.images });
          break;
        }
        for (const call of calls.values()) if (!call.result) call.abandoned = true;
        current = {
          key: `t${event.seq}`,
          seq: event.seq,
          prompt: { text, images: payload.images, ts: event.ts, seq: event.seq },
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
      case "turn_started":
        break;
      case "assistant_text": {
        const turn = ensureTurn(event);
        if (payload.text.trim()) turn.work.push({ kind: "text", text: payload.text, key: `a${event.seq}`, seq: event.seq });
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
          else if (!lastText) turn.work.push({ kind: "text", text: payload.finalText, key: `f${event.seq}`, seq: event.seq });
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
        modelRequestOpen = true;
        break;
      case "usage_update":
        if (payload.contextUsed != null) contextUsed = payload.contextUsed;
        if (payload.contextMax != null) contextMax = payload.contextMax;
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
      case "api_retry":
        retry = { attempt: payload.attempt, maxRetries: payload.maxRetries, reason: payload.reason };
        break;
      case "rate_limited":
        rateLimit = { status: payload.status, resetsAt: payload.resetsAt };
        break;
      case "status":
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
          turn.work.push({ kind: "status", text: payload.text, key: `st${event.seq}`, seq: event.seq });
        }
        break;
      case "error": {
        const turn = ensureTurn(event);
        turn.work.push({ kind: "error", text: payload.message, key: `e${event.seq}`, seq: event.seq });
        break;
      }
      case "settings_changed":
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
