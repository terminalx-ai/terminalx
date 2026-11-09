// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingTabBar } from "./FloatingTabBar";

vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-router", () => ({ Tabs: {} }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }) }));
vi.mock("react-native", () => {
  const Box = ({ children, style }: { children?: ReactNode; style?: any }) => <div data-dot={style?.[0]?.position === "absolute" || undefined}>{children}</div>;
  return {
    View: Box,
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState }: any) => <button aria-label={accessibilityLabel} aria-selected={accessibilityState?.selected} onClick={onPress}>{children}</button>,
  };
});

let root: Root;
let container: HTMLDivElement;
const routes = ["index", "sessions", "cloud", "settings"].map((name) => ({ key: `${name}-key`, name, params: undefined }));
const navigation = { emit: vi.fn(() => ({ defaultPrevented: false })), navigate: vi.fn() };
const onNew = vi.fn();
const render = (index: number, dotted: string[] = []) => act(async () => {
  root.render(<FloatingTabBar state={{ index, routes } as any} navigation={navigation as any} dotted={dotted} onNew={onNew} />);
});
const button = (label: string) => container.querySelector(`[aria-label='${label}']`) as HTMLButtonElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  navigation.emit.mockClear(); navigation.navigate.mockClear(); onNew.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("the tab bar", () => {
  it("names each tab, marks the open one, and goes to another", async () => {
    await render(1);
    expect(["Machines", "Sessions", "Cloud", "Settings"].map((label) => button(label)?.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    await act(async () => button("Cloud").click());
    expect(navigation.navigate).toHaveBeenCalledWith("cloud", undefined);
    // The open tab is told it was pressed, and goes nowhere.
    navigation.navigate.mockClear();
    await act(async () => button("Sessions").click());
    expect(navigation.emit).toHaveBeenLastCalledWith({ type: "tabPress", target: "sessions-key", canPreventDefault: true });
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("starts a new session from its own button, not a tab", async () => {
    await render(0);
    await act(async () => button("New session").click());
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("dots a tab with something waiting", async () => {
    await render(0);
    expect(button("Sessions").querySelector("[data-dot]")).toBeNull();
    await render(0, ["sessions"]);
    expect(button("Sessions").querySelector("[data-dot]")).not.toBeNull();
  });
});
