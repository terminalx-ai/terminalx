import { describe, expect, it, vi } from "vitest";
import { CONTINUE_PROMPT, RECOVERY_PROMPT } from "@terminalx/portable/recovery";
import type { HostConnection } from "../transport/connection";
import { HostApi } from "./host-api";
import { continueHere, continueInNewTab, recoveryState, retrySafely, settingsView } from "./session-controls";

vi.mock("expo-crypto", () => ({ randomUUID: () => "client-id" }));

const ok = (value: unknown = null) => ({ ok: true, value });
const refused = (message: string) => ({ ok: false, refusal: { code: "refused", message } });
function api(reply: (method: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => reply(method, params));
  return { request, api: new HostApi({ request, onEvent: () => () => {} } as unknown as HostConnection) };
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
    expect(await host.stop("s", "t")).toEqual({ done: false, message: "This paired device is read-only." });
    expect(await host.resendUnsent("s", "t")).toEqual({ sent: false, message: "This paired device is read-only." });
    expect(await host.continueInNewTab("s", "t", { harness: "claude", model: "" }, "p")).toEqual({ started: false, message: "This paired device is read-only." });
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
    expect(await retrySafely(host, "s", "t", "opus")).toEqual({ sent: true, queued: false });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["session.stop", "session.setModel", "session.send"]);
    expect(request.mock.calls[2]![1]).toMatchObject({ tabId: "t", text: RECOVERY_PROMPT });
    const refusing = api(() => refused("Stop has not confirmed local process exit."));
    expect(await retrySafely(refusing.api, "s", "t")).toEqual({ sent: false, message: "Stop has not confirmed local process exit." });
    expect(refusing.request).toHaveBeenCalledTimes(1);
  });

  it("continues in the same conversation with the desktop's word for it", async () => {
    const { request, api: host } = api(() => ok({ status: "sent", queued: false }));
    await continueHere(host, "t");
    expect(request.mock.calls[0]).toEqual(["session.send", { tabId: "t", text: CONTINUE_PROMPT }]);
  });

  it("builds the handoff from the prepared context, and says when the complete history cannot be read", async () => {
    const { request, api: host } = api((method) => method === "session.prepareContinuation" ? ok(context) : ok({ tab: { id: "new" }, delivered: true, inInput: false }));
    expect(await continueInNewTab(host, "s", "t", { harness: "codex", model: "gpt-5.6", permissionMode: "auto" }, "focused")).toMatchObject({ started: true, tabId: "new", delivered: true });
    const [, params] = request.mock.calls[1]!;
    expect(params).toMatchObject({ sessionId: "s", tabId: "t", tab: { harness: "codex", model: "gpt-5.6", permissionMode: "auto" } });
    expect(params?.prompt).toContain("bounded, partial recent conversation capture");
    expect(await continueInNewTab(host, "s", "t", { harness: "codex", model: "" }, "full")).toEqual({ started: false, message: "No transcript was saved." });
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
});
