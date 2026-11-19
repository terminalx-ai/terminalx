import { describe, expect, it, vi } from "vitest";
import { CONTINUE_PROMPT, RECOVERY_PROMPT } from "@terminalx/portable/recovery";
import type { HostConnection } from "../transport/connection";
import { HostApi } from "./host-api";
import { RelayOuterError } from "../transport/relay-client";
import { continueHere, continueInNewTab, recoveryState, resendLast, resumeLogDetail, retrySafely, settingsView } from "./session-controls";

vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));

const ok = (value: unknown = null) => ({ ok: true, value });
const refused = (message: string) => ({ ok: false, refusal: { code: "refused", message } });
function api(reply: (method: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => reply(method, params));
  const awaitConnected = vi.fn(async () => true);
  return { request, awaitConnected, api: new HostApi({ request, awaitConnected, onEvent: () => () => {} } as unknown as HostConnection) };
}
const models = [
  { id: "opus", label: "Opus", harness: "claude", efforts: ["low", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null, alias: true },
  { id: "gpt-5.6", label: "GPT-5.6", harness: "codex", efforts: ["medium"], defaultEffort: "medium", acceptsImages: true, isDefault: true, upgrade: null, description: null },
];
const context = { sessionId: "s", tabId: "t", title: "Fix sign in", provider: "claude", providerSessionId: "p", cwd: "/w", sourceActive: false, transcriptPath: null, fullUnavailableReason: "No transcript was saved.", lastPrompt: "fix it", lastUpdate: null, partialCapture: "user: fix it" };

describe("the phone's session control requests", () => {
  it("asks the Mac with the tab each control is for, and only a Mac that says it takes them", async () => {
    const { request, api: host } = api((method) => method === "sync.capabilities" ? ok({ sessionControls: 1 }) : method === "models.list" ? ok(models) : ok());
    expect(await host.sessionControls()).toBe(true);
    await host.stop("s", "t");
    await host.interrupt("s", "t");
    await host.setModel("s", "t", "opus");
    await host.setEffort("s", "t", null);
    await host.setMode("s", "t", "plan");
    expect(await host.models(true)).toHaveLength(2);
    expect(request.mock.calls.slice(1)).toEqual([
      ["session.stop", { sessionId: "s", tabId: "t" }],
      ["session.interrupt", { sessionId: "s", tabId: "t" }],
      ["session.setModel", { sessionId: "s", tabId: "t", model: "opus" }],
      ["session.setEffort", { sessionId: "s", tabId: "t", effort: null }],
      ["session.setMode", { sessionId: "s", tabId: "t", mode: "plan" }],
      ["models.list", { refresh: true }],
    ]);
  });

  it("reports the Mac's refusal instead of a silent no", async () => {
    const { api: host } = api(() => refused("This paired device is read-only."));
    expect(await host.stop("s", "t")).toEqual({ done: false, message: "This paired device is read-only.", code: "refused" });
    expect(await host.resendUnsent("s", "t")).toEqual({ sent: false, message: "This paired device is read-only.", code: "refused" });
    expect(await host.continueInNewTab("s", "t", { harness: "claude", model: "" }, "p")).toEqual({ started: false, message: "This paired device is read-only.", code: "refused" });
    expect(await host.tabControls("s", "t")).toBeNull();
  });

  it("reads a resend that queued behind a running turn, and a new tab whose handoff was not confirmed", async () => {
    const { api: host } = api((method) => method === "session.resendUnsent" ? ok({ queued: true, events: [] }) : ok({ tab: { id: "new" }, delivered: false, error: "not confirmed" }));
    expect(await host.resendUnsent("s", "t")).toEqual({ sent: true, queued: true });
    expect(await host.continueInNewTab("s", "t", { harness: "claude", model: "" }, "p")).toEqual({ started: true, tabId: "new", delivered: false, inInput: false, message: "not confirmed" });
  });
});

describe("the phone's session controls, as the desktop's", () => {
  it("retries safely by stopping first, on another model when one is chosen, and stops there if the Mac refuses", async () => {
    const { request, api: host } = api(() => ok({ status: "sent", queued: false }));
    expect(await retrySafely(host, "s", "t", "opus")).toEqual({ done: true });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["session.stop", "session.setModel", "session.send"]);
    expect(request.mock.calls[2]![1]).toMatchObject({ tabId: "t", text: RECOVERY_PROMPT });
    const refusing = api(() => refused("Stop has not confirmed local process exit."));
    expect(await retrySafely(refusing.api, "s", "t")).toEqual({ done: false, failure: {
      action: "retry-safely", step: "stop", code: "refused", next: "retry", pending: false,
      text: "Your Mac did not stop the agent. It said: Stop has not confirmed local process exit. Try again, or open the session on the Mac to see more.",
    } });
    expect(refusing.request).toHaveBeenCalledTimes(1);
  });

  it("continues in the same conversation with the desktop's word for it", async () => {
    const { request, api: host } = api(() => ok({ status: "sent", queued: false }));
    await continueHere(host, "t");
    expect(request.mock.calls[0]).toEqual(["session.send", { tabId: "t", text: CONTINUE_PROMPT }]);
  });

  it("builds the handoff from the prepared context, and says when the complete history cannot be read", async () => {
    const { request, api: host } = api((method) => method === "session.prepareContinuation" ? ok(context) : ok({ tab: { id: "new" }, delivered: true, inInput: false }));
    expect(await continueInNewTab(host, "s", "t", { harness: "codex", model: "gpt-5.6", permissionMode: "auto" }, "focused")).toEqual({ done: true, tabId: "new" });
    const [, params] = request.mock.calls[1]!;
    expect(params).toMatchObject({ sessionId: "s", tabId: "t", tab: { harness: "codex", model: "gpt-5.6", permissionMode: "auto" } });
    expect(params?.prompt).toContain("bounded, partial recent conversation capture");
    expect(await continueInNewTab(host, "s", "t", { harness: "codex", model: "" }, "full")).toMatchObject({ done: false, failure: { step: "prepare", code: "context_unavailable", text: "Not continued: No transcript was saved. Choose a shorter handoff, or continue on the Mac." } });
  });

  it("offers the tab's own models and efforts, and says what is still switching", () => {
    const view = settingsView({ harness: "claude", model: "opus", effort: "xhigh", permissionMode: "", requestedEffort: "low", status: "in_progress" }, models);
    expect(view.models.map((model) => model.id)).toEqual(["opus"]);
    expect(view.efforts.map((effort) => [effort.id, effort.pending])).toEqual([["low", true], ["high", false], ["xhigh", false]]);
    expect(view.modeName).toBe("Bypass permissions");
    expect(view.modes.find((mode) => mode.current)?.id).toBe("bypassPermissions");
    expect(view.modes.some((mode) => mode.pending)).toBe(false);
    expect(view.note).toBe("Switching to Low effort after this turn");
  });

  it("reads what stopped the tab from its events, as the desktop does", () => {
    const event = (seq: number, payload: unknown) => ({ id: String(seq), sessionId: "s", tabId: "t", harness: "claude", seq, ts: "", payload }) as never;
    expect(recoveryState([event(1, { type: "recovery", kind: "unsent" })], 0).offer.resend).toBe(true);
    expect(recoveryState([event(1, { type: "recovery", kind: "failed" }), event(2, { type: "user_message", text: "next", queued: false })], 0).kind).toBeNull();
    expect(recoveryState([event(1, { type: "recovery", kind: "signed_out" })], 0).offer.signIn).toBe(false);
  });

  it("never sends a native Codex tab to a terminal it does not have, and still sends a terminal tab there (#644)", () => {
    const event = (seq: number, payload: unknown) => ({ id: String(seq), sessionId: "s", tabId: "t", harness: "codex", seq, ts: "", payload }) as never;
    for (const kind of ["permission_expired", "delivery_unconfirmed"]) {
      const lapsed = [event(1, { type: "recovery", kind })];
      expect(recoveryState(lapsed, 0, { transport: "experimentalCodexStdio" }).offer.message, kind).not.toMatch(/terminal/i);
      // A tab whose agent runs in its terminal, and an older Mac that does not say, keep pointing there.
      expect(recoveryState(lapsed, 0, { transport: "pty" }).offer.message, kind).toMatch(/Check the terminal/);
      expect(recoveryState(lapsed, 0, null).offer.message, kind).toMatch(/Check the terminal/);
    }
  });
});

describe("a resume on the Mac that fails (#1290)", () => {
  const throwing = (error: unknown) => api(() => { throw error; });

  it("waits for the connection while the phone reconnects, then sends once", async () => {
    const { request, awaitConnected, api: host } = api(() => ok({ status: "sent", queued: false }));
    expect(await continueHere(host, "t")).toEqual({ done: true });
    expect(awaitConnected).toHaveBeenCalledTimes(1);
    expect(awaitConnected.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]!);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("says a resume the connection was not back in time for as never sent, with Reconnect", async () => {
    const { request, api: host } = throwing(new Error("Host is disconnected"));
    const result = await continueHere(host, "t");
    expect(result).toEqual({ done: false, failure: {
      action: "continue-here", step: "connect", code: "dropped", next: "reconnect", pending: false,
      text: "Not resumed: the connection to your Mac dropped before it could be sent. Reconnect, then try again.",
    } });
    // Not sent again by itself.
    expect(request).toHaveBeenCalledTimes(1);
    expect(resumeLogDetail((result as { failure: Parameters<typeof resumeLogDetail>[0] }).failure)).toBe("Continue here · step connect · code dropped");
    const relay = await continueHere(throwing(new Error("Relay connection unavailable")).api, "t");
    expect(relay).toMatchObject({ done: false, failure: { step: "connect", next: "reconnect" } });
  });

  it("shows a resume the Mac has not answered in time as under way, not as a failure, and never repeats it", async () => {
    const { request, api: host } = throwing(new Error("RPC timed out: session.send"));
    const result = await continueHere(host, "t");
    expect(result).toMatchObject({ done: false, failure: { step: "send", code: "no-answer", next: "wait", pending: true } });
    expect((result as { failure: { text: string } }).failure.text).toMatch(/may still be under way/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("says a step before the resume that got no answer as a failure, not as a resume under way", async () => {
    const stop = api((method) => { if (method === "session.stop") throw new Error("RPC timed out: session.stop"); return ok({ status: "sent", queued: false }); });
    const stopped = await retrySafely(stop.api, "s", "t");
    expect(stopped).toEqual({ done: false, failure: {
      action: "retry-safely", step: "stop", code: "no-answer", next: "retry", pending: false,
      text: "Not resumed: your Mac didn't answer in time while stopping the agent, so the resume was not sent. Try again.",
    } });
    // The prompt was never asked for.
    expect(stop.request.mock.calls.map(([method]) => method)).toEqual(["session.stop"]);
    const model = api((method) => { if (method === "session.setModel") throw new Error("RPC timed out: session.setModel"); return ok(); });
    expect(await retrySafely(model.api, "s", "t", "opus")).toMatchObject({ done: false, failure: { step: "model", pending: false, next: "retry", text: "The agent was stopped, but the resume was not finished: your Mac didn't answer in time while switching the model, so the resume was not sent. Try again." } });
    expect(model.request.mock.calls.map(([method]) => method)).toEqual(["session.stop", "session.setModel"]);
    const prepare = api(() => { throw new Error("RPC timed out: session.prepareContinuation"); });
    expect(await continueInNewTab(prepare.api, "s", "t", { harness: "claude", model: "" }, "focused")).toMatchObject({ done: false, failure: { step: "prepare", pending: false, next: "retry", text: "Not resumed: your Mac didn't answer in time while preparing the handoff, so the resume was not sent. Try again." } });
    expect(prepare.request.mock.calls.map(([method]) => method)).toEqual(["session.prepareContinuation"]);
    // The resume itself unanswered is still under way, also for Retry safely's last step.
    const send = api((method) => { if (method === "session.send") throw new Error("RPC timed out: session.send"); return ok(); });
    expect(await retrySafely(send.api, "s", "t")).toMatchObject({ done: false, failure: { step: "send", pending: true, next: "wait" } });
  });

  it("says a connection lost while the resume was on its way may or may not have arrived", async () => {
    const result = await resendLast(throwing(new RelayOuterError(4408)).api, "s", "t");
    expect(result).toMatchObject({ done: false, failure: { action: "resend", step: "send", code: "dropped", next: "reconnect", pending: false } });
    expect((result as { failure: { text: string } }).failure.text).toMatch(/may or may not have reached your Mac/);
    const offline = await resendLast(throwing(new RelayOuterError(4404)).api, "s", "t");
    expect(offline).toMatchObject({ done: false, failure: { code: "mac-offline", next: "reconnect" } });
  });

  it("says a pairing the relay refuses has to be made again, with no Try again", async () => {
    const result = await continueHere(throwing(new RelayOuterError(4401)).api, "t");
    expect(result).toMatchObject({ done: false, failure: { code: "pairing-invalid", next: "mac" } });
    expect((result as { failure: { text: string } }).failure.text).toBe("Not resumed: this phone is no longer paired with your Mac; pair it again from Machines.");
  });

  it("says the step after the stop that failed, so the person knows the agent was stopped", async () => {
    let calls = 0;
    const lost = api((method) => {
      calls += 1;
      if (method === "session.stop") return ok();
      throw new Error("Relay connection closed");
    });
    const result = await retrySafely(lost.api, "s", "t");
    expect(calls).toBe(2);
    expect(result).toMatchObject({ done: false, failure: { action: "retry-safely", step: "send", code: "dropped" } });
    expect((result as { failure: { text: string } }).failure.text).toMatch(/^The agent was stopped, but the resume was not finished: /);
    const model = api((method) => method === "session.setModel" ? refused("Unknown model.") : ok({ status: "sent", queued: false }));
    expect(await retrySafely(model.api, "s", "t", "nope")).toMatchObject({ done: false, failure: { step: "model", text: "The agent was stopped, but your Mac did not switch the model. It said: Unknown model. Try again, or open the session on the Mac to see more." } });
    const send = api((method) => method === "session.send" ? refused("The agent is not running") : ok());
    expect(await retrySafely(send.api, "s", "t")).toMatchObject({ done: false, failure: { step: "send", code: "refused", text: "The agent was stopped, but your Mac did not send the prompt. It said: The agent is not running. Try again, or open the session on the Mac to see more." } });
  });

  it("names the step of Continue in new session that failed: preparing the handoff, or opening the new conversation", async () => {
    const prepare = api((method) => method === "session.prepareContinuation" ? refused("No such tab.") : ok());
    expect(await continueInNewTab(prepare.api, "s", "t", { harness: "claude", model: "" }, "focused")).toMatchObject({ done: false, failure: { step: "prepare", code: "refused", text: expect.stringMatching(/^Your Mac did not prepare the handoff\. It said: No such tab\./) } });
    const open = api((method) => {
      if (method === "session.prepareContinuation") return ok(context);
      throw new Error("RPC timed out: session.continue");
    });
    expect(await continueInNewTab(open.api, "s", "t", { harness: "claude", model: "" }, "focused")).toMatchObject({ done: false, failure: { step: "open", code: "no-answer", pending: true } });
    const unconfirmed = api((method) => method === "session.prepareContinuation" ? ok(context) : ok({ tab: { id: "new" }, delivered: false, inInput: true }));
    expect(await continueInNewTab(unconfirmed.api, "s", "t", { harness: "claude", model: "" }, "focused")).toEqual({ done: true, tabId: "new", note: "The handoff is in the new conversation's input but has not been sent yet." });
  });

  it("says a failure that is not the connection's and not the Mac's as this phone's, never as its raw message", async () => {
    const result = await continueHere(throwing(new TypeError("undefined is not a function")).api, "t");
    expect(result).toMatchObject({ done: false, failure: { code: "client_error", next: "retry", text: "Not resumed: something on this phone stopped the request. Try again." } });
  });
});

