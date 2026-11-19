// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Clipboard from "expo-clipboard";
import { buildTranscript, type WorkItem } from "@terminalx/portable/transcript";
import { SHELL_FOLD_LINES } from "@terminalx/portable/harnessText";
import type { AgentEvent } from "@terminalx/portable/events";
import { TurnCard } from "./transcript";

vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("./TranscriptList", () => ({ useTranscriptReveal: () => vi.fn() }));
vi.mock("./PromptImages", () => ({ PromptImages: () => null }));
vi.mock("lucide-react-native", () => {
  const icon = (name: string) => Object.assign(() => <i data-icon={name} />, { displayName: name });
  return { Check: icon("check"), CheckCheck: icon("check-check"), Copy: icon("copy"), SquareTerminal: icon("square-terminal") };
});
vi.mock("react-native", () => {
  const Box = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  const Inline = ({ children, testID }: { children?: ReactNode; testID?: string }) => <span data-testid={testID}>{children}</span>;
  return {
    View: Box, Text: Inline,
    Platform: { OS: "ios", select: ({ ios }: any) => ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, testID, accessibilityLabel, accessibilityState }: any) => <button data-testid={testID} aria-label={accessibilityLabel} aria-expanded={accessibilityState?.expanded} onClick={onPress}>{children}</button>,
    Keyboard: { isVisible: () => false, addListener: () => ({ remove: () => undefined }) },
    ActionSheetIOS: {}, Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() },
    TextInput: () => null,
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const user = (seq: number, text: string): AgentEvent => ({ id: `e${seq}`, seq, ts: "2026-11-19T10:00:00Z", sessionId: "s", tabId: "t", harness: "claude", payload: { type: "user_message", text, queued: false } });
const draw = (...records: string[]) => {
  const [turn] = buildTranscript(records.map((text, i) => user(i + 1, text)), false).turns;
  act(() => root.render(<TurnCard turn={turn} />));
  return turn;
};
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("a Claude Code `!` command on the phone (#1294)", () => {
  it("draws one shell block, not the reader's message with tags", () => {
    const turn = draw("<bash-input> git status</bash-input>", "<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>");
    expect(turn.work.map((item: WorkItem) => item.kind)).toEqual(["shell"]);
    expect(container.querySelectorAll('[data-testid="shell-block"]')).toHaveLength(1);
    expect(byId("shell-block")?.textContent).toContain("$ git status");
    expect(byId("shell-stdout")?.textContent).toBe("On branch main");
    expect(byId("shell-stderr")).toBeNull();
    expect(container.textContent).not.toContain("<bash-");
  });

  it("draws stderr alone, and folds long output behind Show more", () => {
    draw("<bash-input>make</bash-input>", `<bash-stdout></bash-stdout><bash-stderr>${Array.from({ length: 30 }, (_, i) => `err ${i}`).join("\n")}</bash-stderr>`);
    expect(byId("shell-stdout")).toBeNull();
    expect(byId("shell-stderr")?.textContent?.split("\n")).toHaveLength(SHELL_FOLD_LINES);
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show more")!;
    act(() => more.click());
    expect(byId("shell-stderr")?.textContent?.split("\n")).toHaveLength(30);
  });

  it("copies the command and its output", async () => {
    draw("<bash-input>pwd</bash-input>", "<bash-stdout>/repo</bash-stdout><bash-stderr></bash-stderr>");
    await act(async () => (byId("shell-copy") as HTMLButtonElement).click());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("$ pwd\n/repo");
  });
});
