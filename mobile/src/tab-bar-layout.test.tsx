// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tab bar on each system: iOS keeps its SF Symbols and the New session action set apart; Android needs
// Material Symbols for its marks, shows every label, and holds five items at most, so New session is not in
// its bar even with Bots on (six items crash Android's bottom navigation).
const mocks = vi.hoisted(() => ({ os: "android", bots: false, tabs: undefined as any }));
vi.mock("react-native", () => ({ Platform: { get OS() { return mocks.os; } } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: { ink: "#ink", muted: "#muted", card: "#card", selected: "#selected" } }) }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({ api: {}, activeHost: { id: "h" } }) }));
vi.mock("@mobile/state/bots", () => ({ useBotsOffered: () => mocks.bots }));
vi.mock("expo-router/unstable-native-tabs", () => {
  const NativeTabs = (props: any) => { mocks.tabs = props; return <nav>{props.children}</nav>; };
  NativeTabs.Trigger = function Trigger({ name, hidden, children }: any) { return hidden ? null : <section data-name={name}>{children}</section>; };
  (NativeTabs.Trigger as any).Icon = function Icon({ sf, md }: any) { return <i data-sf={sf} data-md={md} />; };
  (NativeTabs.Trigger as any).Label = function Label({ children }: { children?: ReactNode }) { return <b>{children}</b>; };
  return { NativeTabs };
});
const { default: TabLayout } = await import("../app/(tabs)/_layout");

let root: Root;
let container: HTMLDivElement;
const show = () => act(async () => { root.render(<TabLayout />); });
const shown = () => [...container.querySelectorAll("section")].map((tab) => tab.dataset.name);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(mocks, { os: "android", bots: false, tabs: undefined });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("on Android", () => {
  it("gives every tab a Material Symbol and a label that always shows, in the theme's colours", async () => {
    await show();
    for (const icon of container.querySelectorAll("i")) expect(icon.getAttribute("data-md")).toBeTruthy();
    expect(mocks.tabs.labelVisibilityMode).toBe("labeled");
    expect(mocks.tabs.backgroundColor).toBe("#card");
    expect(mocks.tabs.iconColor).toEqual({ default: "#muted", selected: "#ink" });
  });

  it("keeps the bar to five items with Bots on, leaving New session to the Sessions page", async () => {
    mocks.bots = true;
    await show();
    expect(shown()).toEqual(["index", "sessions", "bots", "cloud", "settings"]);
  });
});

describe("on iOS", () => {
  it("keeps New session in the bar and the SF Symbols", async () => {
    mocks.os = "ios";
    mocks.bots = true;
    await show();
    expect(shown()).toEqual(["index", "sessions", "bots", "cloud", "settings", "new"]);
    for (const icon of container.querySelectorAll("i")) expect(icon.getAttribute("data-sf")).toBeTruthy();
    expect(mocks.tabs.backgroundColor).toBeUndefined();
  });
});
