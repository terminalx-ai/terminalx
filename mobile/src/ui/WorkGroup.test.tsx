// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCall, Turn } from "@terminalx/portable/transcript";
import { WorkGroup } from "./WorkGroup";
import { TranscriptRow, TurnCard } from "./transcript";
import { turnRows } from "./transcript-rows";

// Design 22.03: folded command rows, and where the reader's message is.

vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./TranscriptList", () => ({ useTranscriptReveal: () => vi.fn() }));
vi.mock("./PromptImages", () => ({ PromptImages: () => null }));
vi.mock("lucide-react-native", () => {
  const icon = (name: string) => Object.assign(() => <i data-icon={name} />, { displayName: name });
  return { Check: icon("check"), CheckCheck: icon("check-check"), SquareTerminal: icon("square-terminal") };
});
vi.mock("react-native", () => {
  const Box = ({ children, testID, accessibilityLabel }: { children?: ReactNode; testID?: string; accessibilityLabel?: string }) => <div data-testid={testID} aria-label={accessibilityLabel}>{children}</div>;
  const Inline = ({ children, testID, numberOfLines }: { children?: ReactNode; testID?: string; numberOfLines?: number }) => <span data-testid={testID} data-lines={numberOfLines}>{children}</span>;
  return {
    View: Box, Text: Inline,
    Platform: { OS: "ios", select: ({ ios }: any) => ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, testID, accessibilityState }: any) => <button data-testid={testID} aria-expanded={accessibilityState?.expanded} onClick={onPress}>{children}</button>,
    Keyboard: { isVisible: () => false, addListener: () => ({ remove: () => undefined }) },
    ActionSheetIOS: {}, Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() },
  };
});
vi.mock("./primitives", () => ({
  Button: ({ label, onPress }: any) => <button onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const draw = (node: ReactNode) => act(() => root.render(node));
const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const one = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const tap = (element: HTMLElement | null) => act(() => element!.click());

const loop = 'date \'+%H:%M\'; for p in "PRO-341" "PRO-128"; do\n  gh issue view "$p" --json state\ndone';
const calls: ToolCall[] = [
  { callId: "a", name: "Bash", toolType: "shell", input: { command: loop, description: "Check the time and each ticket's state" }, title: loop, seq: 2, result: { text: "", isError: false } },
  { callId: "b", name: "Bash", toolType: "shell", input: { command: "tail -6 /private/var/folders/x1/T/tasks/build.log", description: "Read the last lines of the task log" }, title: "tail -6 /private/var/folders/x1/T/tasks/build.log", seq: 3, result: { text: "", isError: false } },
];

describe("a folded run of commands", () => {
  it("is one line until tapped, with no command in sight", () => {
    draw(<WorkGroup calls={calls} />);
    expect(one("work-group-header")?.textContent).toBe("Ran 2 commands");
    expect(one("work-group-header")?.getAttribute("aria-expanded")).toBe("false");
    expect(one("work-group-calls")).toBeNull();
    expect(container.textContent).not.toContain("tail -6");
  });

  it("opens to each call's description first, then its command on one line", () => {
    draw(<WorkGroup calls={calls} />);
    tap(one("work-group-header"));
    expect(one("work-group-header")?.getAttribute("aria-expanded")).toBe("true");
    const entries = all("work-group-call");
    expect(entries).toHaveLength(2);
    for (const [index, entry] of entries.entries()) {
      const [description, command] = [...entry.children] as HTMLElement[];
      expect(description.dataset.testid).toBe("work-group-description");
      expect(description.textContent).toBe(calls[index].input && (calls[index].input as { description: string }).description);
      expect(command.dataset.testid).toBe("work-group-command");
      // One line of raw command, however long, until the command itself is tapped.
      expect(command.querySelector("span")?.dataset.lines).toBe("1");
    }
    expect(entries[0].querySelector("[data-testid=work-group-command]")?.textContent).toBe("date '+%H:%M'; for p in \"PRO-341\" \"PRO-128\"; do …");
    expect(entries[1].querySelector("[data-testid=work-group-command]")?.textContent).toBe("tail -6 /private/var/folders/x1/T/tasks/build.log");
  });

  it("shows a command whole when it is tapped, and one line again on a second tap", () => {
    draw(<WorkGroup calls={calls} />);
    tap(one("work-group-header"));
    const command = () => all("work-group-command")[0];
    tap(command());
    expect(command().textContent).toBe(loop);
    expect(command().querySelector("span")?.dataset.lines).toBeUndefined();
    tap(command());
    expect(command().querySelector("span")?.dataset.lines).toBe("1");
  });

  it("names a single call in the agent's words, and opens to its command alone", () => {
    draw(<WorkGroup calls={[calls[1]]} />);
    expect(one("work-group-header")?.textContent).toBe("Read the last lines of the task log");
    tap(one("work-group-header"));
    expect(one("work-group-description")).toBeNull();
    expect(one("work-group-command")?.textContent).toBe("tail -6 /private/var/folders/x1/T/tasks/build.log");
  });

  it("draws a call a safety check held open, with what held it, and nothing to tap open (#775)", () => {
    const held: ToolCall = { ...calls[1], callId: "h", result: { text: "", isError: false, safetyCheck: "Approved past Claude's dangerous-removal check" } };
    draw(<WorkGroup calls={[held]} />);
    expect(one("work-group-header")?.tagName).toBe("DIV");
    expect(one("tool-safety-check")?.textContent).toBe("Approved past Claude's dangerous-removal check");
    expect(one("work-group-command")?.querySelector("span")?.dataset.lines).toBe("1");
  });

  it("is how a turn's consecutive calls are drawn, a reply between them making two runs", () => {
    const turn: Turn = { key: "t", seq: 1, ts: "2026-11-15T10:22:00Z", toolCount: 3, editedFiles: 0, live: false, work: [
      { kind: "tool", key: "ca", call: calls[0] }, { kind: "tool", key: "cb", call: calls[1] },
      { kind: "text", key: "x", seq: 4, text: "Two checks still run." },
      { kind: "tool", key: "cc", call: { ...calls[1], callId: "c" } },
    ] };
    draw(<TurnCard turn={turn} />);
    expect(all("work-group-header").map((header) => header.textContent)).toEqual(["Ran 2 commands", "Read the last lines of the task log"]);
  });
});

describe("where the reader's message is, under it", () => {
  const prompt = (extra: object = {}): Turn => ({ key: "t", seq: 1, ts: "2026-11-15T10:22:00Z", toolCount: 0, editedFiles: 0, live: false, prompt: { text: "What's the latest status?", seq: 1, ts: "2026-11-15T10:22:00Z", messageTs: "2026-11-15T10:22:00Z", ...extra }, work: [] });
  const drawRows = (turn: Turn) => draw(<>{turnRows(turn).map((row) => <TranscriptRow key={row.key} row={row} />)}</>);

  it("ticks a message the Mac has, beside its time", () => {
    drawRows(prompt());
    expect(one("message-delivered")?.getAttribute("aria-label")).toBe("Delivered to your Mac");
    expect(one("message-delivered")?.querySelector("[data-icon=check-check]")).not.toBeNull();
    expect(one("message-queued")).toBeNull();
  });

  it("says the workspace has it in a cloud workspace, where there is no Mac", () => {
    draw(<TurnCard turn={prompt()} deliveredTo="workspace" />);
    expect(one("message-delivered")?.getAttribute("aria-label")).toBe("Delivered to the workspace");
    draw(<TurnCard turn={prompt()} />);
    expect(one("message-delivered")?.getAttribute("aria-label")).toBe("Delivered to your Mac");
  });

  it("says Queued under a message waiting for the agent, in place of the tick", () => {
    drawRows({ ...prompt(), work: [{ kind: "queued", key: "q", seq: 2, text: "and then deploy", messageTs: "2026-11-15T10:23:00Z" }] });
    expect(all("message-delivered")).toHaveLength(1);
    expect(one("message-queued")?.textContent).toBe("Queued");
    expect(container.textContent).toContain("and then deploy");
    expect(container.textContent).not.toContain("Queued · ");
  });

  it("shows neither while delivery is not confirmed, and says so", () => {
    drawRows(prompt({ unconfirmed: true }));
    expect(one("message-delivered")).toBeNull();
    expect(one("message-queued")).toBeNull();
    expect(container.textContent).toContain("Delivery was not confirmed.");
  });
});
