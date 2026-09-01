import type { AgentEvent, BackgroundTask, FileEdit, Payload, PermissionOption, Question, ToolResult } from "@/types/events";

/**
 * Turns an event log into what the transcript draws.
 *
 * A turn opens at a user message and closes at turn_completed. Work items are
 * the events inside it; runs of same-tool calls fold into a group. Tool calls
 * join their results by call id; a call the log leaves open is "pending" only
 * while the tab is live, otherwise it is drawn as abandoned.
 */

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
  const ensureTurn = (ev: AgentEvent) => {
    if (!current) {
      current = { key: `t${ev.seq}`, seq: ev.seq, work: [], toolCount: 0, editedFiles: 0, live: false };
      turns.push(current);
    }
    return current;
  };

  for (const ev of events) {
    const p: Payload = ev.payload;
    switch (p.type) {
      case "user_message": {
        if (p.queued && current && !current.completed) {
          current.work.push({ kind: "queued", text: p.text, key: `q${ev.seq}`, seq: ev.seq, images: p.images });
          break;
        }
        // A new prompt abandons any call still open.
        for (const c of calls.values()) if (!c.result) c.abandoned = true;
        current = {
          key: `t${ev.seq}`,
          seq: ev.seq,
          prompt: { text: p.text, images: p.images, ts: ev.ts, seq: ev.seq },
          work: [],
          toolCount: 0,
          editedFiles: 0,
          live: false,
        };
        turns.push(current);
        modelRequestOpen = false;
        workingSince = Date.parse(ev.ts);
        break;
      }
      case "turn_started":
        break;
      case "assistant_text": {
        const t = ensureTurn(ev);
        if (p.text.trim()) t.work.push({ kind: "text", text: p.text, key: `a${ev.seq}`, seq: ev.seq });
        modelRequestOpen = false;
        break;
      }
      case "reasoning": {
        const t = ensureTurn(ev);
        if (p.text.trim()) t.work.push({ kind: "reasoning", text: p.text, key: `r${ev.seq}`, seq: ev.seq });
        break;
      }
      case "tool_call_started": {
        const t = ensureTurn(ev);
        const call: ToolCall = {
          callId: p.callId,
          name: p.name,
          toolType: p.toolType,
          input: p.input,
          title: p.title,
          seq: ev.seq,
          subagent: ev.subagent,
        };
        calls.set(p.callId, call);
        if (!ev.subagent) {
          t.work.push({ kind: "tool", call, key: `c${p.callId}` });
          t.toolCount++;
          modelRequestOpen = false;
        }
        break;
      }
      case "tool_call_completed": {
        const c = calls.get(p.callId);
        if (c) {
          c.result = p.result;
          c.abandoned = false;
        }
        break;
      }
      case "file_edits": {
        const c = p.callId ? calls.get(p.callId) : undefined;
        if (c) c.edits = (c.edits ?? []).concat(p.edits);
        if (current) current.editedFiles += new Set(p.edits.map((e) => e.path)).size;
        break;
      }
      case "turn_completed": {
        const t = ensureTurn(ev);
        for (const c of calls.values()) if (!c.result) c.abandoned = true;
        t.completed = { status: p.status, durationMs: p.durationMs, ts: ev.ts, head: p.head };
        // finalText duplicates the last assistant block; only keep it when it adds something.
        const lastText = [...t.work].reverse().find((w) => w.kind === "text");
        if (p.finalText && (!lastText || (lastText.kind === "text" && lastText.text.trim() !== p.finalText.trim()))) {
          if (p.status !== "ok") t.finalText = p.finalText;
          else if (!lastText) t.work.push({ kind: "text", text: p.finalText, key: `f${ev.seq}`, seq: ev.seq });
        }
        if (p.usage) {
          if (p.usage.contextUsed != null) contextUsed = p.usage.contextUsed;
          if (p.usage.contextMax != null) contextMax = p.usage.contextMax;
          t.usage = { contextUsed: p.usage.contextUsed, contextMax: p.usage.contextMax };
        }
        if (p.authFailed) authFailed = true;
        modelRequestOpen = false;
        compacting = false;
        retry = undefined;
        workingSince = undefined;
        current = null;
        break;
      }
      case "permission_requested":
        asks.set(p.requestId, {
          requestId: p.requestId,
          toolUseId: p.toolUseId,
          seq: ev.seq,
          kind: "permission",
          toolName: p.toolName,
          title: p.title,
          description: p.description,
          input: p.input,
          options: p.options,
        });
        break;
      case "questions_asked":
        asks.set(p.requestId, { requestId: p.requestId, toolUseId: p.toolUseId, seq: ev.seq, kind: "questions", questions: p.questions });
        break;
      case "permission_decided": {
        asks.delete(p.requestId);
        if (current && !p.automatic) {
          current.work.push({ kind: "decision", label: p.label, allowed: p.allowed, automatic: p.automatic, key: `d${ev.seq}`, seq: ev.seq });
        }
        break;
      }
      case "permission_denied":
        break;
      case "subagent_started": {
        const t = ensureTurn(ev);
        t.work.push({ kind: "subagent", agentId: p.agentId, label: p.label, done: false, key: `s${p.agentId}`, seq: ev.seq });
        break;
      }
      case "subagent_completed": {
        for (const t of turns) {
          const w = t.work.find((w) => w.kind === "subagent" && w.agentId === p.agentId);
          if (w && w.kind === "subagent") w.done = true;
        }
        break;
      }
      case "background_tasks_changed":
        tasks = p.tasks;
        break;
      case "model_request_started":
        modelRequestOpen = true;
        break;
      case "usage_update":
        if (p.contextUsed != null) contextUsed = p.contextUsed;
        if (p.contextMax != null) contextMax = p.contextMax;
        break;
      case "context_compaction_started":
        compacting = true;
        break;
      case "context_compacted": {
        compacting = false;
        if (p.postTokens != null) contextUsed = p.postTokens;
        const t = ensureTurn(ev);
        t.work.push({ kind: "compaction", preTokens: p.preTokens, postTokens: p.postTokens, key: `k${ev.seq}`, seq: ev.seq });
        break;
      }
      case "api_retry":
        retry = { attempt: p.attempt, maxRetries: p.maxRetries, reason: p.reason };
        break;
      case "rate_limited":
        rateLimit = { status: p.status, resetsAt: p.resetsAt };
        break;
      case "status": {
        if (p.text.startsWith("rate_limit:")) {
          try {
            const parsed = JSON.parse(p.text.slice("rate_limit:".length));
            if (parsed && typeof parsed === "object") usageWindows = parsed;
          } catch {
            /* ignore */
          }
        } else if (p.text.startsWith("codex_rate_limit:")) {
          try {
            const parsed = JSON.parse(p.text.slice("codex_rate_limit:".length));
            const primary = parsed?.primary;
            if (primary && typeof primary.usedPercent === "number") {
              codexUsage = { usedPercent: primary.usedPercent, resetsAt: primary.resetsAt, windowMins: primary.windowDurationMins, plan: parsed.planType };
            }
          } catch {
            /* ignore */
          }
        } else if (p.text.startsWith("tool_pending:")) {
          // handled by streaming previews
        } else {
          const t = ensureTurn(ev);
          t.work.push({ kind: "status", text: p.text, key: `st${ev.seq}`, seq: ev.seq });
        }
        break;
      }
      case "error": {
        const t = ensureTurn(ev);
        t.work.push({ kind: "error", text: p.message, key: `e${ev.seq}`, seq: ev.seq });
        break;
      }
      case "settings_changed":
      case "delta":
      case "unknown":
        break;
    }
  }

  // Pending-ness: a call is only pending while the tab is live.
  if (!live) for (const c of calls.values()) if (!c.result) c.abandoned = true;
  const last = turns[turns.length - 1];
  if (last && !last.completed && live) last.live = true;
  if (!live) {
    modelRequestOpen = false;
    workingSince = undefined;
  }

  for (const t of turns) t.work = groupWork(t.work);

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

/** Runs of ≥2 consecutive calls to one groupable tool fold into one row. */
export function groupWork(items: WorkItem[]): WorkItem[] {
  const out: WorkItem[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === "tool" && GROUPABLE.has(it.call.name) && !it.call.result?.images?.length) {
      let j = i + 1;
      const run: ToolCall[] = [it.call];
      while (j < items.length) {
        const n = items[j];
        if (n.kind === "tool" && n.call.name === it.call.name && !n.call.result?.images?.length) {
          run.push(n.call);
          j++;
        } else break;
      }
      if (run.length >= 2) {
        out.push({ kind: "tool_group", name: it.call.name, calls: run, key: `g${it.call.callId}` });
        i = j;
        continue;
      }
    }
    out.push(it);
    i++;
  }
  return out;
}

export function turnHasAnswer(t: Turn): boolean {
  return t.work.some((w) => w.kind === "text") || !!t.finalText;
}

/** Distinct targets a group touched, for its label. */
export function groupTargets(calls: ToolCall[]): string[] {
  const set = new Set<string>();
  for (const c of calls) {
    const target = callTarget(c);
    if (target) set.add(target);
  }
  return [...set];
}

export function callTarget(c: ToolCall): string | undefined {
  const input = (c.input ?? {}) as Record<string, unknown>;
  for (const k of ["file_path", "path", "notebook_path", "pattern", "command", "query", "url"]) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}
