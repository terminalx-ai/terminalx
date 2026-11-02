// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@terminalx/portable/events";
import { CONTINUE_PROMPT, RECOVERY_PROMPT } from "@terminalx/portable/recovery";
import { SessionControls } from "./ui/SessionControls";

const mocks = vi.hoisted(() => ({ app: {} as any, alerts: [] as { title: string; buttons: { text: string; onPress?: () => void }[] }[] }));
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
const render = async (events: AgentEvent[] = [], asks = 0) => {
  await act(async () => { root.render(<SessionControls sessionId="s" tabId="t" events={events} asks={asks} connected onOpenTab={openTab} />); });
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
  openTab.mockClear();
  mocks.app = {
    refreshSessions: vi.fn(async () => {}),
    activeHost: { id: "mac" },
    api: {
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
