// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type RuntimeAgent } from "@terminalx/portable/workspace";
import { PROVEN_BY_LIVE_CHECK, START_WORDS, startAgents } from "@mobile/cloud/start-tab";
import type { CloudWorkspaceSession, CloudWorkspaceSnapshot } from "@mobile/cloud/workspace";
import { StartAgentSheet } from "./StartAgentSheet";
import { stage } from "./testing/kit";

// PRO-548: New conversation and Add agent tab (25.10), each state of the sheet.
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("./Spinner", () => ({ Spinner: () => <i data-testid="spinner" /> }));
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn() }));

const page = stage();

/** The screen's side: it holds what is typed, as the workspace screen does. */
function Held(props: Omit<Parameters<typeof StartAgentSheet>[0], "text" | "onText"> & { initialText?: string }) {
  const [text, setText] = useState(props.initialText ?? "");
  return <StartAgentSheet {...props} text={text} onText={setText} />;
}
const CLAUDE: RuntimeAgent = {
  id: "claude", name: "Claude Code", caps: {} as never, defaultMode: "bypassPermissions", signIn: "signedIn", modes: ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"],
  models: [{ id: "opus", label: "Opus", efforts: ["medium", "high"], defaultEffort: "high", isDefault: true } as never, { id: "sonnet", label: "Sonnet", efforts: [], defaultEffort: null, isDefault: false } as never],
};
const GEMINI: RuntimeAgent = { ...CLAUDE, id: "gemini", name: "Gemini", signIn: "signedOut" };

/** The session the sheet talks to: its three calls, answered as a test says. */
function workspace(connected = true) {
  const calls: { method: string; args: unknown[] }[] = [];
  const answers = {
    agents: async () => startAgents({ agents: [CLAUDE, GEMINI], missing: [{ id: "opencode", name: "OpenCode" } as never] }),
    create: async (..._args: unknown[]): Promise<{ sessionId: string; tabId: string; promptNotSent: boolean }> => ({ sessionId: "s2", tabId: "t2", promptNotSent: false }),
    add: async (..._args: unknown[]): Promise<{ sessionId: string; tabId: string }> => ({ sessionId: "s1", tabId: "t3" }),
  };
  const session = {
    client: { connection: { state: connected ? "connected" : "stopped" } },
    startAgents: () => answers.agents(),
    startConversation: (...args: unknown[]) => (calls.push({ method: "session.create", args }), answers.create(...args)),
    addAgentTab: (...args: unknown[]) => (calls.push({ method: "session.addTab", args }), answers.add(...args)),
  } as unknown as CloudWorkspaceSession;
  return { session, calls, answers };
}
const snap = (fields: Partial<CloudWorkspaceSnapshot> = {}) => ({ connection: { state: "connected" }, startOffer: "yes", tabs: [{ tabId: "t1" }], ...fields }) as CloudWorkspaceSnapshot;
const labels = () => [...page.byId("start-rows")?.querySelectorAll("[aria-label]") ?? []].map((row) => row.getAttribute("aria-label"));

afterEach(() => { PROVEN_BY_LIVE_CHECK.emptyFirstMessageStartsAgent = false; });

describe("the start sheet (25.10)", () => {
  it("reads the agents, then shows the four rows on their defaults, Ask every time, and the message field", async () => {
    const w = workspace();
    let finish!: () => void;
    const read = w.answers.agents;
    w.answers.agents = () => new Promise((resolve) => { finish = () => resolve(read()); });
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.reading)).not.toBeNull();
    expect(page.byId("start-skeleton")).not.toBeNull();
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => { finish(); });
    expect(labels()).toEqual(["Agent: Claude Code", "Model: Opus", "Effort: High", "Permission mode: Ask every time"]);
    expect(page.byText(START_WORDS.newConversation)).not.toBeNull();
    expect(page.byLabel("First message")!.getAttribute("placeholder")).toBe(START_WORDS.placeholder);
  });

  it("starts with what was typed, and hands back the tab it opened", async () => {
    const w = workspace();
    const started = vi.fn();
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={started} onClose={vi.fn()} />);
    // Until the live check proves an empty first message starts the agent, Start needs a message, and nothing says otherwise.
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).toBe("true");
    expect(page.byText(START_WORDS.noMessage)).toBeNull();
    await page.type(page.byLabel("First message"), "Fix the login bug");
    await page.press(page.byId("start-submit"));
    expect(w.calls).toEqual([{ method: "session.create", args: [{ agent: "claude", model: "opus", effort: "high", mode: "manual" }, { title: "Fix the login bug", prompt: "Fix the login bug" }, expect.any(String)] }]);
    expect(started).toHaveBeenCalledWith({ tabId: "t2", promptNotSent: false, text: "Fix the login bug" });
  });

  it("with the flag on, says an empty first message starts the agent waiting, and lets it start", async () => {
    PROVEN_BY_LIVE_CHECK.emptyFirstMessageStartsAgent = true;
    const w = workspace();
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.noMessage)).not.toBeNull();
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("Add agent tab: its line under the title, no message, and session.addTab for the conversation on screen", async () => {
    const w = workspace();
    const started = vi.fn();
    await page.show(<Held kind="tab" session={w.session} snapshot={snap()} sessionId="s1" onStarted={started} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.addTab)).not.toBeNull();
    expect(page.byText(START_WORDS.addTabUnder)).not.toBeNull();
    expect(page.byLabel("First message")).toBeNull();
    expect(page.byText(START_WORDS.addButton)).not.toBeNull();
    await page.press(page.byId("start-submit"));
    expect(w.calls[0]).toEqual({ method: "session.addTab", args: ["s1", { agent: "claude", model: "opus", effort: "high", mode: "manual" }, expect.any(String)] });
    expect(started).toHaveBeenCalledWith({ tabId: "t3", promptNotSent: false, text: "" });
  });

  it("lists agents not signed in or not installed, dimmed and not pickable, and the four modes without bypass and with the owner's line", async () => {
    const w = workspace();
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    await page.press(page.byId("pick-agent"));
    expect(page.byText(START_WORDS.agentsSubtitle)).not.toBeNull();
    expect(page.byId("choice-gemini")!.getAttribute("aria-disabled")).toBe("true");
    expect(page.styleOf(page.byId("choice-gemini")).opacity).toBe(0.5);
    expect(page.byId("choice-opencode")!.getAttribute("aria-label")).toBe("OpenCode, Not installed in this workspace");
    await page.press(page.byId("choice-sheet-backdrop"));
    await page.press(page.byId("pick-permission-mode"));
    expect(["plan", "manual", "auto", "acceptEdits"].map((id) => !!page.byId(`choice-${id}`))).toEqual([true, true, true, true]);
    expect(page.byId("choice-bypassPermissions")).toBeNull();
    expect(page.byText("Bypass permissions can't be chosen from a phone.")).not.toBeNull();
  });

  it("no answer: says so, offers Try again, and asks again with the same request", async () => {
    const w = workspace();
    w.answers.create = async () => { throw new Error("RPC timed out: session.create"); };
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    await page.type(page.byLabel("First message"), "Go");
    await page.press(page.byId("start-submit"));
    expect(page.byText(START_WORDS.noAnswer)).not.toBeNull();
    expect(page.byText(START_WORDS.tryAgain)).not.toBeNull();
    await page.press(page.byId("start-submit"));
    expect(w.calls[1]!.args[2]).toBe(w.calls[0]!.args[2]);
  });

  it("says no answer came after 35 s while the client still waits, and opens the tab when the answer comes late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const w = workspace();
      let answer!: (value: { sessionId: string; tabId: string; promptNotSent: boolean }) => void;
      w.answers.create = () => new Promise((resolve) => { answer = resolve; });
      const started = vi.fn();
      await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={started} onClose={vi.fn()} />);
      await page.type(page.byLabel("First message"), "Go");
      await page.press(page.byId("start-submit"));
      expect(page.byText(START_WORDS.starting)).not.toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
      expect(page.byText(START_WORDS.noAnswer)).not.toBeNull();
      expect(started).not.toHaveBeenCalled();
      await act(async () => { answer({ sessionId: "s2", tabId: "t2", promptNotSent: false }); });
      expect(started).toHaveBeenCalledWith({ tabId: "t2", promptNotSent: false, text: "Go" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refusal says who can, and the next try is a new request", async () => {
    const w = workspace();
    w.answers.create = async () => { throw new WorkspaceRpcError("forbidden", "needs a workspace manager", "session.create", { role: "driver" }); };
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    await page.type(page.byLabel("First message"), "Go");
    await page.press(page.byId("start-submit"));
    expect(page.byText(START_WORDS.refused)).not.toBeNull();
    await page.press(page.byId("start-submit"));
    expect(w.calls[1]!.args[2]).not.toBe(w.calls[0]!.args[2]);
  });

  it("any other refusal is the general sentence", async () => {
    const w = workspace();
    w.answers.create = async () => { throw new WorkspaceRpcError("invalid_params", "mode is required", "session.create", { reason: "mode-required" }); };
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    await page.type(page.byLabel("First message"), "Go");
    await page.press(page.byId("start-submit"));
    expect(page.byText(START_WORDS.other)).not.toBeNull();
  });

  it("the agents could not be read: the danger line with Try again, and nothing else to do", async () => {
    const w = workspace();
    w.answers.agents = async () => { throw new Error("method_not_found"); };
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap()} onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.unread)).not.toBeNull();
    expect(page.byId("start-rows")).toBeNull();
    expect(page.byLabel("First message")).toBeNull();
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("not connected: says so, and Start waits for the connection", async () => {
    const w = workspace(false);
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap({ connection: { state: "stopped" } as never, startOffer: null })} onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.offline)).not.toBeNull();
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("while the workspace starts: the spinner line, the rows' outline, and a message can be written", async () => {
    const w = workspace(false);
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap({ connection: { state: "connecting" } as never, startOffer: null })} waking onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.waking)).not.toBeNull();
    expect(page.byId("start-skeleton")).not.toBeNull();
    expect(page.byLabel("First message")).not.toBeNull();
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).toBe("true");
  });

  it("the workspace did not start: the start's own sentence with Try again, the message kept", async () => {
    const w = workspace(false);
    const retry = vi.fn();
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap({ connection: { state: "stopped" } as never, startOffer: null })} initialText="Keep me"
      waking wakeFailure="The cloud provider is not answering right now. Try again in a moment." onRetryWake={retry} onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText("The cloud provider is not answering right now. Try again in a moment.")).not.toBeNull();
    await page.press(page.byText(START_WORDS.tryAgain)?.closest("[role='button']") ?? null);
    expect(retry).toHaveBeenCalledOnce();
    expect(page.byId("start-rows")).toBeNull();
  });

  it("a runtime too old says to restart it, and nothing can be started", async () => {
    const w = workspace();
    await page.show(<Held kind="conversation" session={w.session} snapshot={snap({ startOffer: "old" })} onStarted={vi.fn()} onClose={vi.fn()} />);
    expect(page.byText(START_WORDS.old)).not.toBeNull();
    expect(page.byId("start-submit")!.getAttribute("aria-disabled")).toBe("true");
  });
});
