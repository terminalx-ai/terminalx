// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatLink, LinkedText } from "./LinkedText";

const mocks = vi.hoisted(() => ({ open: vi.fn(), copy: vi.fn(), sheet: vi.fn(), alert: vi.fn(), os: "ios" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("./theme", () => ({ useTheme: () => ({ palette: { accent: "#a96f27" } }) }));
vi.mock("react-native", () => ({
  Platform: { get OS() { return mocks.os; } },
  Linking: { openURL: mocks.open }, ActionSheetIOS: { showActionSheetWithOptions: mocks.sheet }, Alert: { alert: mocks.alert },
  Text: ({ children, onPress, onLongPress, accessibilityRole }: any) => <span role={accessibilityRole} onClick={onPress} onContextMenu={onLongPress}>{children}</span>,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); mocks.os = "ios"; mocks.open.mockResolvedValue(undefined); mocks.copy.mockResolvedValue(true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (node: ReactNode) => { await act(async () => root.render(node)); };
const hold = async () => { await act(async () => container.querySelector('[role="link"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))); };

it("opens a bare URL and copies its full destination from the iOS hold menu", async () => {
  const href = "https://example.com/path?q=a%20b#result";
  await render(<LinkedText>{`See (${href}).`}</LinkedText>);
  expect(container.textContent).toBe(`See (${href}).`);
  await act(async () => (container.querySelector('[role="link"]') as HTMLElement).click());
  expect(mocks.open).toHaveBeenCalledWith(href);
  mocks.open.mockClear();
  await hold();
  const [options, choose] = mocks.sheet.mock.calls[0];
  expect(options.options).toEqual(["Open link", "Copy link", "Cancel"]);
  await act(async () => choose(1));
  expect(mocks.copy).toHaveBeenCalledWith(href);
  expect(mocks.open).not.toHaveBeenCalled();
});

it("copies the destination of a labeled markdown link on Android", async () => {
  mocks.os = "android";
  await render(<ChatLink href="https://example.com/hidden-destination">Documentation</ChatLink>);
  await hold();
  const actions = mocks.alert.mock.calls[0][2];
  await act(async () => actions.find((action: any) => action.text === "Copy link").onPress());
  expect(mocks.copy).toHaveBeenCalledWith("https://example.com/hidden-destination");
});

it("offers copying for host file references without asking the phone to open a local path", async () => {
  await render(<ChatLink href="/workspace/src/main.ts:12">Source</ChatLink>);
  await act(async () => (container.querySelector('[role="link"]') as HTMLElement).click());
  const [options, choose] = mocks.sheet.mock.calls[0];
  expect(options.options).toEqual(["Copy link", "Cancel"]);
  await act(async () => choose(0));
  expect(mocks.copy).toHaveBeenCalledWith("/workspace/src/main.ts:12");
  expect(mocks.open).not.toHaveBeenCalled();
});
