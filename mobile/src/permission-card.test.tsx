// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingAsk, Turn } from "@terminalx/portable/transcript";
import { PermissionCard, TurnCard } from "./ui/transcript";

vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("./ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("lucide-react-native", () => ({ Terminal: () => null }));
vi.mock("react-native", () => {
  const Box = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  const Inline = ({ children, testID }: { children?: ReactNode; testID?: string }) => <span data-testid={testID}>{children}</span>;
  return {
    View: Box, Text: Inline,
    Platform: { OS: "web", select: ({ default: fallback }: any) => fallback },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>,
    ActionSheetIOS: {}, Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() },
  };
});
vi.mock("./ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const draw = (node: ReactNode) => act(() => root.render(node));
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

// #775: the phone says what the desktop card says. In bypass mode Claude Code's own safety check asked, and the agent's description is labelled as the agent's.
const reason = "Claude Code's safety check wants approval for this command. Bypass permissions doesn't cover commands it can't verify.";
const ask: PendingAsk = {
  requestId: "r", toolUseId: "", seq: 1, kind: "permission", toolName: "Bash", title: "Bash",
  input: { command: 'a=("${(@f)$(printf "x\\ny")}"); echo ${#a}', description: "Clear the composer and type the prompt" },
  description: "Clear the composer and type the prompt", reason,
  options: [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "deny" }],
};

it("says on the phone's card that Claude's safety check asked, apart from the agent's description (#775)", () => {
  const respond = vi.fn();
  draw(<PermissionCard ask={ask} connected answering={false} onRespond={respond} />);
  expect(byTestId("permission-reason")?.textContent).toBe(reason);
  expect(byTestId("permission-agent-note")?.textContent).toBe("Agent: Clear the composer and type the prompt");
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Allow")!.click();
  expect(respond).toHaveBeenCalledWith("allow");

  draw(<PermissionCard ask={{ ...ask, reason: undefined }} connected answering={false} onRespond={vi.fn()} />);
  expect(byTestId("permission-reason")).toBeNull();
  expect(container.textContent).not.toContain("safety check");
});

it("says on the phone's tool row which of Claude's checks held the call (#775)", () => {
  const turn = (safetyCheck?: string): Turn => ({
    key: "t", seq: 1, ts: "2026-11-06T00:00:00Z", toolCount: 1, editedFiles: 0, live: false,
    work: [{ kind: "tool", key: "c", call: { callId: "c", name: "Bash", toolType: "shell", input: { command: "ls" }, title: "ls", seq: 1, result: { text: "", isError: false, safetyCheck } } }],
  });
  draw(<TurnCard turn={turn("Approved past Claude's dangerous-removal check")} />);
  expect(byTestId("tool-safety-check")?.textContent).toBe("Approved past Claude's dangerous-removal check");
  draw(<TurnCard turn={turn()} />);
  expect(byTestId("tool-safety-check")).toBeNull();
});
