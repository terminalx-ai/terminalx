// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Payload } from "@terminalx/portable/events";
import { buildTranscript, messageTime } from "@terminalx/portable/transcript";
import { elapsed, StatusLine, statusLineState, statusLineText, type StatusLineState } from "./StatusLine";

vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("./Spinner", () => ({ Spinner: () => <i data-spinner /> }));
vi.mock("react-native", () => {
  const Box = ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => <div aria-label={accessibilityLabel}>{children}</div>;
  return {
    View: Box, Text: Box,
    StyleSheet: { create: (styles: unknown) => styles },
    // A long press is a right-click here.
    Pressable: ({ children, onPress, onLongPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress} onContextMenu={onLongPress ? (event) => { event.preventDefault(); onLongPress(); } : undefined}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
  };
});

const NOW = Date.parse("2026-11-15T10:25:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
let seq = 0;
const ev = (payload: Payload, ts = ago(0), extra: Partial<AgentEvent> = {}): AgentEvent => ({ id: `e${++seq}`, sessionId: "s", tabId: "t", harness: "claude", seq, ts, payload, ...extra });
const prompt = (text: string, ts: string) => ev({ type: "user_message", text, queued: false }, ts);
const started = (ts: string) => ev({ type: "turn_started" }, ts);
const ended = (status: "ok" | "error" | "aborted", ts: string, more: Partial<Extract<Payload, { type: "turn_completed" }>> = {}) => ev({ type: "turn_completed", status, authFailed: false, ...more }, ts);
const question = (requestId: string, ts: string) => ev({ type: "questions_asked", requestId, toolUseId: "", questions: [{ question: "Merge now, or wait for the macOS job?", header: "Merge", options: [{ label: "Merge now" }, { label: "Wait for it" }], multiSelect: false }] } as Payload, ts);
const permission = (requestId: string, ts: string) => ev({ type: "permission_requested", requestId, toolUseId: "tool", toolName: "Bash", input: { command: "gh pr merge" }, options: [{ id: "allow", label: "Allow", kind: "allow_once" }] } as Payload, ts);
const decided = (requestId: string, ts: string) => ev({ type: "permission_decided", requestId, allowed: true, label: "Allow", automatic: false }, ts);

/** The line's state as the screen derives it: the transcript built from the events, connected. */
const stateOf = (events: AgentEvent[], tabStatus?: "idle" | "in_progress" | "completed" | "waiting") => statusLineState({ transcript: buildTranscript(events, true), events, tabStatus });
const read = (state: StatusLineState | null) => state && statusLineText(state, NOW, "en-US", "UTC");

beforeEach(() => { seq = 0; });

describe("statusLineState, from the transcript's events", () => {
  it("says Working, with how long the turn has run", () => {
    const events = [prompt("What's the latest status?", ago(3)), started(ago(3))];
    expect(stateOf(events)).toEqual({ kind: "working", since: Date.parse(ago(3)) });
    expect(read(stateOf(events))).toEqual({ label: "Working", detail: "3 min" });
  });

  it("goes from Working to Needs your answer when the agent asks, and back to Working once answered", () => {
    const events = [prompt("Merge it when green", ago(5)), started(ago(5))];
    expect(stateOf(events)?.kind).toBe("working");
    events.push(question("q1", ago(1)));
    expect(stateOf(events)).toEqual({ kind: "needs_answer", since: Date.parse(ago(1)) });
    expect(read(stateOf(events))).toEqual({ label: "Needs your answer", detail: "1 min" });
    events.push(decided("q1", ago(0)));
    expect(stateOf(events)?.kind).toBe("working");
  });

  it("says Needs approval, in the Sessions list's words, while a permission request waits", () => {
    const events = [prompt("Merge it", ago(4)), started(ago(4)), permission("p1", ago(2))];
    expect(stateOf(events)).toEqual({ kind: "needs_approval", since: Date.parse(ago(2)) });
    expect(read(stateOf(events))).toEqual({ label: "Needs approval", detail: "2 min" });
  });

  it("goes from Working to Done, with the time the turn ended", () => {
    const events = [prompt("Check the checks", ago(4)), started(ago(4))];
    expect(stateOf(events, "in_progress")?.kind).toBe("working");
    events.push(ended("ok", ago(1)));
    // The Sessions list may still say in progress: the turn's own end wins.
    expect(stateOf(events, "in_progress")).toEqual({ kind: "done", at: ago(1) });
    expect(read(stateOf(events))).toEqual({ label: "Done", detail: messageTime(ago(1), "en-US", "UTC")!.short });
  });

  it("says Stopped, with the reason the Mac gave or else when", () => {
    const stopped = [prompt("Run the suite", ago(6)), started(ago(6)), ended("aborted", ago(2))];
    expect(stateOf(stopped)).toEqual({ kind: "stopped", reason: null, at: ago(2) });
    expect(read(stateOf(stopped))).toEqual({ label: "Stopped", detail: messageTime(ago(2), "en-US", "UTC")!.short });
    const timedOut = [...stopped, ev({ type: "recovery", kind: "timeout" }, ago(2))];
    expect(read(stateOf(timedOut))).toEqual({ label: "Stopped", detail: "timed out" });
  });

  it("says Failed, with the reason in a few plain words", () => {
    const failed = [prompt("Deploy", ago(3)), started(ago(3)), ended("error", ago(1), { finalText: "**API Error**: 529 `overloaded_error`\nRetry later." })];
    expect(read(stateOf(failed))).toEqual({ label: "Failed", detail: "API Error: 529 overloaded_error" });
    const limited = [...failed, ev({ type: "recovery", kind: "usage_limit" }, ago(1))];
    expect(read(stateOf(limited))).toEqual({ label: "Failed", detail: "usage limit reached" });
    const signedOut = [prompt("Deploy", ago(3)), ended("error", ago(1), { authFailed: true })];
    expect(read(stateOf(signedOut))).toEqual({ label: "Failed", detail: "signed out" });
    const long = [prompt("Deploy", ago(3)), ended("error", ago(1), { finalText: "The agent exited because the configured model is not available to this account at all" })];
    expect(read(stateOf(long))!.detail).toBe("The agent exited because the configured model i…");
  });

  it("says Failed when the agent's launch was refused, with no turn end", () => {
    const events = [prompt("Start", ago(2)), ev({ type: "error", message: "Codex is not installed on this Mac.", fatal: true }, ago(1))];
    expect(read(stateOf(events))).toEqual({ label: "Failed", detail: "Codex is not installed on this Mac." });
  });

  it("falls back to the Mac's tab status where the transcript says nothing", () => {
    expect(stateOf([], "in_progress")).toEqual({ kind: "working" });
    expect(read(stateOf([], "waiting"))).toEqual({ label: "Needs you", detail: null });
    expect(stateOf([], "idle")).toBeNull();
    expect(stateOf([], "completed")).toBeNull();
    // Disconnected (no live transcript): a turn without its end is Working only while the Mac said so.
    const events = [prompt("Hello", ago(2))];
    expect(statusLineState({ transcript: buildTranscript(events, false), events, tabStatus: "in_progress" })).toEqual({ kind: "working", since: Date.parse(ago(2)) });
    expect(statusLineState({ transcript: buildTranscript(events, false), events, tabStatus: "idle" })).toBeNull();
  });

  it("keeps Done when a line the agent printed after the turn's end opens no new prompt", () => {
    const events = [prompt("Go", ago(3)), started(ago(3)), ended("ok", ago(1)), ev({ type: "error", message: "MCP server disconnected", fatal: false }, ago(0))];
    expect(stateOf(events, "completed")).toEqual({ kind: "done", at: ago(1) });
  });

  it("ignores a subagent's events", () => {
    const events = [prompt("Go", ago(3)), started(ago(3)), ended("ok", ago(1)), ev({ type: "error", message: "subagent broke", fatal: true }, ago(0), { subagent: { id: "a" } as AgentEvent["subagent"] })];
    expect(stateOf(events)?.kind).toBe("done");
  });
});

describe("elapsed", () => {
  it("counts minutes, then hours, then days", () => {
    expect(elapsed(NOW - 20_000, NOW)).toBe("just now");
    expect(elapsed(NOW - 3 * 60_000, NOW)).toBe("3 min");
    expect(elapsed(NOW - 60 * 60_000, NOW)).toBe("1 h");
    expect(elapsed(NOW - 125 * 60_000, NOW)).toBe("2 h 5 min");
    expect(elapsed(NOW - 28 * 3_600_000, NOW)).toBe("1 d 4 h");
    expect(elapsed(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("StatusLine", () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = (node: ReactNode) => act(async () => { root.render(node); });
  const stop = () => [...container.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === "Stop");
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

  it("draws Working with its time and a Stop that stops the turn, and keeps counting", async () => {
    const onStop = vi.fn();
    await render(<StatusLine state={{ kind: "working", since: NOW - 3 * 60_000 }} onStop={onStop} />);
    expect(container.textContent).toContain("Working · 3 min");
    await act(async () => { stop()!.click(); });
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(container.textContent).toContain("Working · 4 min");
  });

  it("counts a new wait from the clock read when it began, not the line's last read", async () => {
    await render(<StatusLine state={{ kind: "working", since: NOW - 3 * 60_000 }} />);
    // Fourteen seconds on, before the line's next read, the agent asks: it asked a minute after the turn's clock says.
    await act(async () => { vi.setSystemTime(NOW + 14_000); });
    await render(<StatusLine state={{ kind: "needs_answer", since: NOW + 14_000 - 60_000 }} />);
    expect(container.textContent).toContain("Needs your answer · 1 min");
  });

  it("offers Stop only while a turn is open, only when the Mac takes it, and not twice", async () => {
    await render(<StatusLine state={{ kind: "working", since: NOW }} />);
    expect(stop()).toBeUndefined();
    await render(<StatusLine state={{ kind: "working", since: NOW }} onStop={() => undefined} stopping />);
    expect(stop()!.disabled).toBe(true);
    await render(<StatusLine state={{ kind: "done", at: ago(1) }} onStop={() => undefined} />);
    expect(stop()).toBeUndefined();
    expect(container.textContent).toContain("Done · ");
  });

  it("turns its ring while working, and a long press on Stop offers to stop the session (22.03)", async () => {
    const onStop = vi.fn();
    const onStopSession = vi.fn();
    await render(<StatusLine state={{ kind: "working", since: NOW }} onStop={onStop} onStopSession={onStopSession} />);
    expect(container.querySelector("[data-spinner]")).not.toBeNull();
    await act(async () => { stop()!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(onStopSession).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
    await render(<StatusLine state={{ kind: "done", at: ago(1) }} />);
    expect(container.querySelector("[data-spinner]")).toBeNull();
  });

  it("keeps Stop, and its long press, while the agent waits on a question or a permission request", async () => {
    for (const state of [{ kind: "needs_answer", since: NOW }, { kind: "needs_approval", since: NOW }, { kind: "needs_you" }] as const) {
      const onStop = vi.fn();
      const onStopSession = vi.fn();
      await render(<StatusLine state={state} onStop={onStop} onStopSession={onStopSession} />);
      await act(async () => { stop()!.click(); });
      expect(onStop).toHaveBeenCalledTimes(1);
      await act(async () => { stop()!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
      expect(onStopSession).toHaveBeenCalledTimes(1);
    }
    await render(<StatusLine state={{ kind: "stopped", reason: null, at: ago(1) }} onStop={() => undefined} />);
    expect(stop()).toBeUndefined();
  });

  it("draws nothing without a state", async () => {
    await render(<StatusLine state={null} />);
    expect(container.textContent).toBe("");
  });
});
