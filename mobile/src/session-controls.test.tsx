// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@terminalx/portable/events";
import { CONTINUE_PROMPT, RECOVERY_PROMPT } from "@terminalx/portable/recovery";
import { clearTranscriptCaches } from "./data/transcript-cache";
import { SessionControls } from "./ui/SessionControls";

const mocks = vi.hoisted(() => ({ app: {} as any, alerts: [] as { title: string; buttons: { text: string; onPress?: () => void }[] }[], storage: new Map<string, string>() }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => mocks.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.storage.set(key, value); },
  removeItem: async (key: string) => { mocks.storage.delete(key); },
  getAllKeys: async () => [...mocks.storage.keys()],
  multiRemove: async (keys: string[]) => { for (const key of keys) mocks.storage.delete(key); },
} }));
vi.mock("./state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("./ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box, Text: Box, ScrollView: Box,
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? <div role="dialog">{children}</div> : null,
    Alert: { alert: (title: string, _message: string, buttons: { text: string; onPress?: () => void }[]) => { mocks.alerts.push({ title, buttons }); } },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
  };
});
vi.mock("./ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
}));

let root: Root;
let container: HTMLDivElement;
const openTab = vi.fn();
const models = [
  { id: "opus", label: "Opus", harness: "claude", efforts: ["low", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null, alias: true },
  { id: "sonnet", label: "Sonnet", harness: "claude", efforts: ["low", "high"], defaultEffort: "high", acceptsImages: true, isDefault: false, upgrade: null, description: null, alias: true },
  { id: "gpt-5.6", label: "GPT-5.6", harness: "codex", efforts: ["medium"], defaultEffort: "medium", acceptsImages: true, isDefault: true, upgrade: null, description: null },
];
const recovery = (kind: string): AgentEvent => ({ id: "r", sessionId: "s", tabId: "t", harness: "claude", seq: 2, ts: "2026-11-01T00:00:00Z", payload: { type: "recovery", kind } } as AgentEvent);
const render = async (events: AgentEvent[] = [], asks = 0, connected = true) => {
  await act(async () => { root.render(<SessionControls sessionId="s" tabId="t" events={events} asks={asks} connected={connected} onOpenTab={openTab} />); });
  await act(async () => { await Promise.resolve(); });
};
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Button not found: ${label} in ${container.textContent}`);
  return found;
};
const click = async (label: string) => { await act(async () => { button(label).click(); }); await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.alerts = [];
  mocks.storage.clear();
  openTab.mockClear();
  mocks.app = {
    refreshSessions: vi.fn(async () => {}),
    activeHost: { id: "mac" },
    connectionStage: "connected",
    retryConnection: vi.fn(),
    connection: { note: vi.fn() },
    api: {
      awaitConnected: vi.fn(async () => true),
      features: vi.fn(async () => ({ sessionControls: 1 })),
      onFeaturesChanged: () => () => {},
      tabControls: vi.fn(async () => ({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", status: "idle" })),
      models: vi.fn(async () => models),
      stop: vi.fn(async () => ({ done: true })),
      interrupt: vi.fn(async () => ({ done: true })),
      setModel: vi.fn(async () => ({ done: true })),
      setEffort: vi.fn(async () => ({ done: true })),
      setMode: vi.fn(async () => ({ done: true })),
      resendUnsent: vi.fn(async () => ({ sent: true, queued: false })),
      sendSession: vi.fn(async () => ({ sent: true, queued: false })),
      prepareContinuation: vi.fn(async () => ({ sessionId: "s", tabId: "t", title: "Fix sign in", provider: "claude", providerSessionId: "p", cwd: "/w", sourceActive: false, transcriptPath: "/w/t.jsonl", fullUnavailableReason: null, lastPrompt: "fix it", lastUpdate: null, partialCapture: null })),
      continueInNewTab: vi.fn(async () => ({ started: true, tabId: "new", delivered: true, inInput: false })),
    },
  };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("session controls on the phone", () => {
  it("offers nothing on a Mac without them", async () => {
    mocks.app.api.features.mockResolvedValue({});
    await render();
    expect(container.textContent).toBe("");
  });

  it("stops and interrupts a working agent", async () => {
    mocks.app.api.tabControls.mockResolvedValue({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", status: "in_progress" });
    await render();
    await click("Interrupt");
    expect(mocks.app.api.interrupt).toHaveBeenCalledWith("s", "t");
    await click("Stop");
    expect(mocks.app.api.stop).toHaveBeenCalledWith("s", "t");
  });

  it("changes model, effort and mode with the desktop's choices and says what is still switching", async () => {
    mocks.app.api.tabControls.mockResolvedValue({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", requestedModel: "sonnet", status: "in_progress" });
    await render();
    expect(container.textContent).toContain("Switching to Sonnet after this turn");
    await click("Opus");
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sonnet (latest)  · switching…");
    expect(dialog.textContent).not.toContain("GPT-5.6");
    await click("Opus (latest)");
    expect(mocks.app.api.setModel).toHaveBeenCalledWith("s", "t", "opus");
    await click("High");
    await click("Low");
    expect(mocks.app.api.setEffort).toHaveBeenCalledWith("s", "t", "low");
    await click("Auto");
    await click("Plan");
    expect(mocks.app.api.setMode).toHaveBeenCalledWith("s", "t", "plan");
  });

  it("asks before Bypass, as the desktop does", async () => {
    await render();
    await click("Auto");
    await click("Bypass permissions");
    expect(mocks.app.api.setMode).not.toHaveBeenCalled();
    expect(mocks.alerts[0]?.title).toBe("Bypass permissions?");
    await act(async () => { mocks.alerts[0]!.buttons.find((choice) => choice.text === "Bypass")!.onPress!(); });
    expect(mocks.app.api.setMode).toHaveBeenCalledWith("s", "t", "bypassPermissions");
  });

  it("never sends a native Codex tab to a terminal it does not have; a terminal tab is still sent there (#644)", async () => {
    mocks.app.api.tabControls.mockResolvedValue({ harness: "codex", model: "gpt-5.6", effort: "medium", permissionMode: "auto", status: "waiting", transport: "experimentalCodexStdio" });
    await render([recovery("permission_expired")]);
    expect(container.textContent).toContain("The permission request expired. Send a message to carry on, or stop the session.");
    expect(container.textContent).not.toMatch(/terminal/i);
    mocks.app.api.tabControls.mockResolvedValue({ harness: "codex", model: "gpt-5.6", effort: "medium", permissionMode: "auto", status: "waiting", transport: "pty" });
    await render([recovery("permission_expired"), { ...recovery("permission_expired"), id: "again", seq: 3 }]);
    expect(container.textContent).toContain("Check the terminal for a new request or stop the session.");
  });

  it("retries safely, continues here, and stops from the recovery banner", async () => {
    await render([recovery("failed")]);
    expect(container.textContent).toContain("Needs attention");
    await click("Retry safely");
    expect(mocks.app.api.stop).toHaveBeenCalledWith("s", "t");
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("t", RECOVERY_PROMPT);
    await click("Continue here");
    expect(mocks.app.api.sendSession).toHaveBeenLastCalledWith("t", CONTINUE_PROMPT);
    await click("Stop session");
    expect(mocks.app.api.stop).toHaveBeenCalledTimes(2);
  });

  it("resends a prompt the agent never received, and retries on another model at capacity", async () => {
    await render([recovery("unsent")]);
    expect(container.textContent).not.toContain("Retry safely");
    await click("Resend last prompt");
    expect(mocks.app.api.resendUnsent).toHaveBeenCalledWith("s", "t");
    await render([recovery("capacity")]);
    await click("Choose another model");
    await click("Sonnet (latest)");
    expect(mocks.app.api.setModel).toHaveBeenCalledWith("s", "t", "sonnet");
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("t", RECOVERY_PROMPT);
  });

  it("leaves a request to its card: no recovery action answers it", async () => {
    await render([recovery("failed")], 1);
    expect(container.textContent).toContain("Waiting for input");
    expect(container.textContent).not.toContain("Retry safely");
  });

  it("continues in a new tab with the chosen agent and opens it", async () => {
    await render([recovery("failed")]);
    await click("Continue in new session");
    await click("codex");
    await click("Start");
    expect(mocks.app.api.prepareContinuation).toHaveBeenCalledWith("s", "t");
    const [, , settings, prompt] = mocks.app.api.continueInNewTab.mock.calls[0];
    expect(settings).toEqual({ harness: "codex", model: "", effort: null, permissionMode: "auto" });
    expect(prompt).toContain("Continue work from the prior TerminalX conversation");
    expect(mocks.app.refreshSessions).toHaveBeenCalled();
    expect(openTab).toHaveBeenCalledWith("new");
    expect(container.textContent).toContain("Continued in a new conversation.");
  });

  it("says what went wrong instead of failing silently", async () => {
    mocks.app.api.tabControls.mockResolvedValue({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", status: "in_progress" });
    mocks.app.api.stop.mockResolvedValue({ done: false, message: "This paired device is read-only." });
    await render();
    await click("Stop");
    expect(container.textContent).toContain("This paired device is read-only.");
  });
});

describe("a resume that fails on the phone (#1290)", () => {
  it("says a resume the connection dropped for in plain words, offers Reconnect, and logs its step and code", async () => {
    await render([recovery("failed")]);
    mocks.app.api.sendSession.mockRejectedValueOnce(new Error("Host is disconnected"));
    await click("Continue here");
    expect(container.textContent).toContain("Not resumed: the connection to your computer dropped before it could be sent. Reconnect, then try again.");
    expect(container.textContent).not.toContain("Host is disconnected");
    expect(mocks.app.connection.note).toHaveBeenCalledWith("error", "Session resume failed", "Continue here · step connect · code dropped");
    // Reconnect is offered once the screen shows the connection gone.
    mocks.app.connectionStage = "reconnecting";
    await render([recovery("failed")], 0, false);
    await click("Reconnect");
    expect(mocks.app.retryConnection).toHaveBeenCalledTimes(1);
  });

  it("shows a resume the computer has not answered in time as under way, not as an error", async () => {
    await render([recovery("failed")]);
    mocks.app.api.sendSession.mockRejectedValueOnce(new Error("RPC timed out: session.send"));
    await click("Continue here");
    expect(container.textContent).toContain("Your computer has not answered yet, so the resume may still be under way.");
    expect(container.textContent).not.toContain("RPC timed out");
    expect(mocks.app.connection.note).toHaveBeenCalledWith("warning", "Session resume not confirmed", "Continue here · step send · code no-answer");
    expect(() => button("Reconnect")).toThrow();
  });

  it("can be asked for while the phone reconnects, waits for the connection, and is sent once however often it is tapped", async () => {
    await render([recovery("failed")]);
    mocks.app.connectionStage = "reconnecting";
    await render([recovery("failed")], 0, false);
    let connect!: (up: boolean) => void;
    mocks.app.api.awaitConnected.mockImplementationOnce(() => new Promise<boolean>((resolve) => (connect = resolve)));
    expect(button("Continue here").disabled).toBe(false);
    // Two taps before the controls redraw as busy.
    await act(async () => { button("Continue here").click(); button("Continue here").click(); });
    expect(mocks.app.api.sendSession).not.toHaveBeenCalled();
    await act(async () => { connect(true); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(mocks.app.api.awaitConnected).toHaveBeenCalledTimes(1);
    expect(mocks.app.api.sendSession).toHaveBeenCalledTimes(1);
    expect(mocks.app.api.sendSession).toHaveBeenCalledWith("t", CONTINUE_PROMPT);
  });

  it("is not offered while the phone is not trying to connect", async () => {
    await render([recovery("failed")]);
    mocks.app.connectionStage = "idle";
    await render([recovery("failed")], 0, false);
    expect(button("Continue here").disabled).toBe(true);
    expect(button("Retry safely").disabled).toBe(true);
  });

  it("says the computer's refusal with the step it refused and the next step", async () => {
    await render([recovery("failed")]);
    mocks.app.api.sendSession.mockResolvedValueOnce({ sent: false, message: "The agent is not running", code: "agent_not_running" });
    await click("Retry safely");
    expect(container.textContent).toContain("The agent was stopped, but your computer did not send the prompt. It said: The agent is not running. Try again, or open the session on the computer to see more.");
    expect(mocks.app.connection.note).toHaveBeenCalledWith("error", "Session resume failed", "Retry safely · step send · code agent_not_running");
  });
});

describe("the controls handed to a composer", () => {
  it("say when the mode lets the agent act without asking, even before the change lands", async () => {
    const seen: boolean[] = [];
    // A setting applied arrives as an event, and the controls read the tab again.
    const draw = async (events: AgentEvent[]) => {
      await act(async () => { root.render(<SessionControls sessionId="s" tabId="t" events={events} asks={0} connected onOpenTab={openTab}>{(parts) => { if (parts) seen.push(parts.settings.mode.bypass); return null; }}</SessionControls>); });
      await act(async () => { await Promise.resolve(); });
    };
    await draw([]);
    expect(seen.at(-1)).toBe(false);
    mocks.app.api.tabControls.mockResolvedValue({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", requestedPermissionMode: "bypassPermissions", status: "idle" });
    await draw([recovery("none")]);
    expect(seen.at(-1)).toBe(true);
  });
});

describe("the controls while the phone is not connected (#983)", () => {
  const labels = () => ["Opus", "High", "Auto"].map((label) => [...container.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label));

  it("keeps the model, effort and mode in place, and unusable, until the phone is connected again", async () => {
    await render();
    expect(labels().every(Boolean)).toBe(true);
    expect(labels().some((item) => item!.disabled)).toBe(false);
    mocks.app.api.tabControls.mockRejectedValue(new Error("Host is disconnected"));
    await render([], 0, false);
    expect(labels().every(Boolean)).toBe(true);
    expect(labels().every((item) => item!.disabled)).toBe(true);
    mocks.app.api.tabControls.mockResolvedValue({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", status: "idle" });
    await render([], 0, true);
    expect(labels().some((item) => item!.disabled)).toBe(false);
  });

  it("shows them on the next open from what was saved, before the phone has connected", async () => {
    await render();
    await act(async () => root.unmount());
    root = createRoot(container);
    // Not connected: the Mac answers nothing.
    for (const method of ["features", "tabControls", "models"] as const) mocks.app.api[method].mockRejectedValue(new Error("Host is disconnected"));
    await render([], 0, false);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(labels().every(Boolean)).toBe(true);
    expect(labels().every((item) => item!.disabled)).toBe(true);
  });

  it("saves nothing for a Mac forgotten while its controls and models were being read", async () => {
    let answerTab!: (value: unknown) => void;
    let answerModels!: (value: unknown) => void;
    mocks.app.api.tabControls.mockImplementation(() => new Promise((done) => { answerTab = done; }));
    mocks.app.api.models.mockImplementation(() => new Promise((done) => { answerModels = done; }));
    await render();
    // Forgotten (or signed out) with both requests under way: the caches are cleared first.
    await act(async () => { await clearTranscriptCaches("mac"); });
    await act(async () => {
      answerTab({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", status: "idle" });
      answerModels(models);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    // Let the write queue drain.
    await act(async () => { await clearTranscriptCaches("other"); });
    expect([...mocks.storage.keys()].filter((key) => key.includes("mac"))).toEqual([]);
  });

  it("does not claim the agent is working from what was saved", async () => {
    mocks.app.api.tabControls.mockResolvedValue({ harness: "claude", model: "opus", effort: "high", permissionMode: "auto", status: "in_progress" });
    await render();
    expect(container.textContent).toContain("Interrupt");
    await render([], 0, false);
    expect(container.textContent).not.toContain("Interrupt");
  });
});
