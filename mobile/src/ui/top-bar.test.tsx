// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { smallTitleShown, TOP_BAR_ROW, topBarScrollInsets } from "./top-bar";
import { Screen } from "./primitives";

const TOP = 59; // an iPhone with a Dynamic Island
const mocks = vi.hoisted(() => ({ os: "ios", tabBar: 74, top: 59, scroll: undefined as any, titleLayout: undefined as any }));
vi.mock("./theme", () => ({ useTheme: () => ({ palette: { page: "#0c0809", ink: "#f4ecee", border: "#ffffff1a", muted: "#ab9aa0" } }) }));
vi.mock("./tab-bar-inset", () => ({ useTabBarInset: () => mocks.tabBar, useInTabs: () => mocks.tabBar > 0 }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: mocks.top, bottom: 34, left: 0, right: 0 }) }));
vi.mock("react-native", () => {
  const flat = (style: any): Record<string, unknown> => Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : style && typeof style === "object" ? style : {};
  const Box = ({ children, testID, style, accessibilityElementsHidden, onLayout }: any) => {
    if (onLayout) mocks.titleLayout = onLayout;
    return <div data-testid={testID} data-style={JSON.stringify(flat(style))} data-hidden={accessibilityElementsHidden ? "true" : undefined}>{children}</div>;
  };
  class Value { constructor(public value: number) {} }
  return {
    View: Box, Text: Box, Pressable: Box, ActivityIndicator: Box,
    ScrollView: (props: any) => { mocks.scroll = props; return <div data-testid="scroll">{props.children}</div>; },
    Animated: { View: Box, Value, timing: (value: Value, { toValue }: { toValue: number }) => ({ start: () => { value.value = toValue; }, stop: () => undefined }) },
    Platform: { get OS() { return mocks.os; } },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
  };
});

let root: Root;
let container: HTMLDivElement;
const render = (node: ReactNode) => act(async () => { root.render(node); });
const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const styleOf = (id: string) => JSON.parse(byId(id)!.dataset.style!);
const scrollTo = (y: number) => act(async () => { mocks.scroll.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } }); });

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(mocks, { os: "ios", tabBar: 74, top: TOP, scroll: undefined, titleLayout: undefined });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("tab page scroll insets", () => {
  // The first content pixel on screen sits at the content's top less the scroll, plus any padding.
  const contentTopOnScreen = (os: string, offset: number) => {
    const insets = topBarScrollInsets(TOP, os);
    return insets.paddingTop - offset;
  };

  it("never lets the scroll content's top edge rise above the safe-area inset at rest or pulled down", () => {
    for (const os of ["ios", "android"]) {
      const insets = topBarScrollInsets(TOP, os);
      const rest = insets.contentOffset?.y ?? 0;
      // At rest and while pulled down to refresh, the content starts at or below the inset.
      for (let offset = rest; offset >= rest - 200; offset -= 10) expect(contentTopOnScreen(os, offset)).toBeGreaterThanOrEqual(TOP);
      expect(insets.scrollIndicatorInsets.top).toBe(TOP);
    }
  });

  it("insets iOS content by the status area, so the refresh spinner sits below the bar", () => {
    expect(topBarScrollInsets(TOP, "ios")).toMatchObject({ contentInset: { top: TOP }, contentOffset: { y: -TOP }, paddingTop: 0 });
    expect(topBarScrollInsets(TOP, "android")).toMatchObject({ contentInset: undefined, paddingTop: TOP });
  });

  it("shows the small title once the large title's foot passes under the bar's row, and hides it when it returns", () => {
    const foot = 12 + 48; // content padding, then the large title
    expect(smallTitleShown(-TOP, foot, TOP)).toBe(false);
    expect(smallTitleShown(foot - TOP - TOP_BAR_ROW - 1, foot, TOP)).toBe(false);
    expect(smallTitleShown(foot - TOP - TOP_BAR_ROW, foot, TOP)).toBe(true);
    expect(smallTitleShown(800, foot, TOP)).toBe(true);
    expect(smallTitleShown(800, undefined, TOP)).toBe(false);
  });
});

describe("Screen in a tab", () => {
  it("draws a solid bar in the page colour over the whole status area, above the scroll view", async () => {
    await render(<Screen title="Settings"><div>rows</div></Screen>);
    expect(mocks.scroll).toMatchObject({ contentInsetAdjustmentBehavior: "never", contentInset: { top: TOP }, contentOffset: { y: -TOP } });
    expect(styleOf("top-bar")).toMatchObject({ position: "absolute", top: 0, left: 0, right: 0 });
    expect(styleOf("top-bar-status")).toMatchObject({ height: TOP, backgroundColor: "#0c0809" });
    // Drawn after the scroll view, so it paints over whatever scrolls under it.
    const order = [...container.querySelectorAll("[data-testid]")].map((node) => node.getAttribute("data-testid"));
    expect(order.indexOf("top-bar")).toBeGreaterThan(order.indexOf("scroll"));
  });

  it("brings the small title in as the large title scrolls away, and takes it out as it comes back", async () => {
    await render(<Screen title="Settings"><div>rows</div></Screen>);
    await act(async () => { mocks.titleLayout({ nativeEvent: { layout: { x: 16, y: 12, width: 343, height: 48 } } }); });
    const title = () => byId("top-bar-title")!;
    expect(title().dataset.hidden).toBe("true");
    expect(title().textContent).toBe("Settings");
    expect(styleOf("top-bar-title")).toMatchObject({ height: TOP_BAR_ROW, backgroundColor: "#0c0809", borderBottomWidth: 0.5, borderBottomColor: "#ffffff1a" });
    await scrollTo(400);
    expect(title().dataset.hidden).toBeUndefined();
    await scrollTo(-TOP);
    expect(title().dataset.hidden).toBe("true");
  });

  it("moves a padded page's refresh spinner below the bar", async () => {
    mocks.os = "android";
    const refresh = <div data-testid="refresh" />;
    await render(<Screen title="Machines" refreshControl={refresh}><div>rows</div></Screen>);
    expect(mocks.scroll.refreshControl.props.progressViewOffset).toBe(TOP);
    expect(mocks.scroll.contentInset).toBeUndefined();
  });

  it("works the same without a Dynamic Island", async () => {
    mocks.top = 20;
    await render(<Screen title="Settings"><div>rows</div></Screen>);
    expect(mocks.scroll.contentInset.top).toBe(20);
    expect(styleOf("top-bar-status")).toMatchObject({ height: 20 });
  });
});

describe("Screen under a stack header", () => {
  it("is unchanged: no top bar, the system insets the content", async () => {
    mocks.tabBar = 0;
    await render(<Screen title="New session"><div>rows</div></Screen>);
    expect(byId("top-bar")).toBeNull();
    expect(mocks.scroll.contentInsetAdjustmentBehavior).toBe("automatic");
  });
});
