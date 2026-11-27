// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BotsScreen from "../app/(tabs)/bots";

// PRO-479 (23.08): the Bots tab. What needs you across every bot comes first, the newest question answerable
// from the list, then the team; a question opens as a sheet with the recommended answer on top.
const mocks = vi.hoisted(() => ({ app: {} as any, overview: {} as any, push: vi.fn(), navigate: vi.fn(), alert: vi.fn() }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/state/bots", () => ({ useBotsOverview: () => mocks.overview, useBotHome: () => mocks.overview, useNow: () => Date.now() }));
vi.mock("@mobile/ui/glass", () => ({ GlassIconButton: ({ label, onPress, disabled }: any) => <button aria-label={label} disabled={disabled} onClick={onPress} /> }));
vi.mock("@mobile/state/connection-view", () => ({ useConnectionState: () => "connected", connectionUsable: () => true }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: new Proxy({}, { get: () => "#888888" }) }) }));
vi.mock("@mobile/ui/pull-refresh", () => ({ usePullRefresh: () => ({ refreshing: false, onRefresh: () => undefined }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push, navigate: mocks.navigate }) }));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  return {
    useWindowDimensions: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
    View, Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>, ScrollView: View, KeyboardAvoidingView: View,
    Modal: ({ children, visible }: { children?: ReactNode; visible: boolean }) => visible ? <div data-testid="modal">{children}</div> : null,
    TextInput: ({ accessibilityLabel, value, onChangeText }: any) => <input aria-label={accessibilityLabel} value={value} onChange={(event) => onChangeText(event.currentTarget.value)} />,
    RefreshControl: () => null, Platform: { OS: "ios" }, Alert: { alert: mocks.alert },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, accessibilityLabel, disabled }: any) => <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{typeof children === "function" ? children({ pressed: false }) : children}</button>,
  };
});
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled, testID }: any) => <button data-testid={testID} onClick={onPress} disabled={disabled}>{label}</button>,
  Card: ({ children, testID }: any) => <div data-testid={testID}>{children}</div>,
  Screen: ({ children, title, titleActions }: any) => <main><h1>{title}</h1>{titleActions}{children}</main>,
  EmptyState: ({ title, detail }: any) => <section><h2>{title}</h2><p>{detail}</p></section>,
}));

const bot = (id: string, name: string, fields: object = {}) => ({ id, slug: name.toLowerCase(), name, roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac", reportsTo: "owner", worksIn: ["personal"], created: "", modified: "", ...fields });
const asking = (number: number, text: string, answers: string[], recommended?: number) => ({ number, title: `Item ${number}`, state: "needsYou", askedBy: "owner", addedBy: "b1", created: "", modified: "", spentUsd: 0, question: { id: `q${number}`, text, answers, ...(recommended !== undefined ? { recommended } : {}), asked: "2026-11-21T10:00:00Z" } });

let root: Root;
let container: HTMLDivElement;
const show = () => act(async () => { root.render(<BotsScreen />); });
const button = (text: string) => [...container.querySelectorAll("button")].find((each) => each.textContent === text || each.getAttribute("aria-label") === text);
const click = (text: string) => act(async () => { button(text)!.click(); });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.push.mockReset();
  mocks.alert.mockReset();
  mocks.app = {
    activeHost: { id: "mac" }, connectionEpoch: 1, sessions: [],
    api: { answerBot: vi.fn(async () => ({ item: null, delivery: { sent: true } })), pauseAllBots: vi.fn(async () => undefined) },
  };
  mocks.overview = {
    offered: true, error: null, refresh: vi.fn(async () => undefined),
    value: {
      bots: { revision: 1, unreadable: 0, bots: [bot("b1", "Atlas"), bot("b2", "Iris", { roleTitle: "UX designer", roleTemplateId: "ux-designer", paused: { at: "2026-11-21T10:00:00Z", by: "owner" } })] },
      needsYou: {
        entries: [
          { kind: "item", botId: "b1", at: new Date().toISOString(), item: asking(4, "Move macOS CI to our own runner: approve the plan?", ["Not now", "Approve and start"], 1) },
          { kind: "item", botId: "b1", at: "2026-11-21T09:00:00Z", item: asking(2, "Token written to a log. Fix now or file it?", ["Fix it now", "File an issue"], 0) },
        ],
        counts: [{ botId: "b1", needsYou: 2, inProgress: 0 }, { botId: "b2", needsYou: 0, inProgress: 1 }],
      },
      team: [{ botId: "b1", working: "Restarting the Phase 2 runs" }, { botId: "b2", working: "Checking PR #1405" }],
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("puts what needs you first, and answers the newest question from the list with its recommended answer", async () => {
  await show();
  const text = container.textContent ?? "";
  expect(text.indexOf("NEEDS YOU · 2")).toBeLessThan(text.indexOf("TEAM · 2 BOTS"));
  expect(text).toContain("Atlas asks");
  expect(text).toContain("Move macOS CI to our own runner: approve the plan?");
  await click("Approve and start");
  expect(mocks.app.api.answerBot).toHaveBeenCalledWith("b1", 4, { answer: 1 }, "q4");
  expect(mocks.overview.refresh).toHaveBeenCalled();
});

it("opens a question as a sheet with the recommended answer on top and room to type a reply", async () => {
  await show();
  await click("Atlas asks: Token written to a log. Fix now or file it?");
  const sheet = container.querySelector("[data-testid='bot-question-sheet']")!;
  expect(sheet).toBeTruthy();
  const answers = [...sheet.querySelectorAll("[data-testid^='bot-answer-']")].map((each) => each.textContent);
  expect(answers).toEqual(["Fix it now · recommended", "File an issue"]);
  const reply = sheet.querySelector("input[aria-label='Your own reply to Atlas']") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reply, "File it, low priority");
    reply.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Send reply");
  expect(mocks.app.api.answerBot).toHaveBeenCalledWith("b1", 2, { text: "File it, low priority" }, "q2");
  expect(container.querySelector("[data-testid='bot-question-sheet']")).toBeNull();
});

it("keeps the sheet open with the computer's refusal when the question was answered elsewhere", async () => {
  mocks.app.api.answerBot = vi.fn(async () => { throw new Error("Atlas no longer asks this on item #2."); });
  await show();
  await click("Atlas asks: Token written to a log. Fix now or file it?");
  await act(async () => { (container.querySelector("[data-testid='bot-answer-1']") as HTMLButtonElement).click(); });
  expect(container.querySelector("[data-testid='bot-question-sheet']")?.textContent).toContain("Atlas no longer asks this on item #2.");
});

it("lists the team with what each bot is doing, and opens a bot's home", async () => {
  await show();
  const text = container.textContent ?? "";
  expect(text).toContain("Needs your answer");
  expect(text).toContain("Paused");
  await click("Iris, UX designer. Paused");
  expect(mocks.push).toHaveBeenCalledWith({ pathname: "/bot/[botId]", params: { botId: "b2", name: "Iris" } });
});

it("pauses every bot from the phone after asking", async () => {
  await show();
  await click("Pause all bots");
  const [title, , choices] = mocks.alert.mock.calls[0]!;
  expect(title).toBe("Pause every bot?");
  await act(async () => { choices.find((choice: { text: string }) => choice.text === "Pause all").onPress(); });
  expect(mocks.app.api.pauseAllBots).toHaveBeenCalledTimes(1);
});

it("shows nothing of the bots from a Mac that does not offer them", async () => {
  mocks.overview = { offered: false, value: null, error: null, refresh: vi.fn() };
  await show();
  expect(container.textContent).toContain("Bots are off");
  expect(container.textContent).not.toContain("NEEDS YOU");
});
