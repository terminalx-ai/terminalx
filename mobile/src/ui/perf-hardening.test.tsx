// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  os: "ios" as "ios" | "android",
  reduceMotion: false,
  reduceTransparency: false,
  motionQueries: 0,
  transparencyQueries: 0,
  listeners: new Map<string, Set<(value: boolean) => void>>(),
  removedListeners: 0,
  blurRenders: 0,
  maskRenders: 0,
  gradientRenders: 0,
  flatListCalls: 0,
}));

vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>;
  return {
    View,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Pressable: ({ children }: { children?: ReactNode | ((state: { pressed: boolean }) => ReactNode) }) => <div>{typeof children === "function" ? children({ pressed: false }) : children}</div>,
    Platform: { get OS() { return mocks.os; }, select: ({ default: d }: any) => d },
    StyleSheet: { create: <T,>(s: T): T => s, hairlineWidth: 1, absoluteFill: {} },
    Animated: {
      View,
      Value: class { setValue() {} interpolate() { return "0deg"; } },
      loop: () => ({ start: () => undefined, stop: () => undefined }),
      timing: () => ({}),
    },
    Easing: { linear: (v: number) => v },
    AccessibilityInfo: {
      isReduceMotionEnabled: vi.fn(async () => { mocks.motionQueries++; return mocks.reduceMotion; }),
      isReduceTransparencyEnabled: vi.fn(async () => { mocks.transparencyQueries++; return mocks.reduceTransparency; }),
      addEventListener: vi.fn((event: string, listener: (value: boolean) => void) => {
        let set = mocks.listeners.get(event);
        if (!set) { set = new Set(); mocks.listeners.set(event, set); }
        set.add(listener);
        return { remove: () => { set!.delete(listener); mocks.removedListeners++; } };
      }),
    },
    FlatList: ({ data = [], renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent }: any) => {
      mocks.flatListCalls++;
      return <div data-testid="flatlist">{ListHeaderComponent}{data.length ? data.map((item: unknown, index: number) => <div key={keyExtractor(item, index)}>{renderItem({ item, index })}</div>) : ListEmptyComponent}</div>;
    },
  };
});

vi.mock("expo-blur", () => ({
  BlurView: () => { mocks.blurRenders++; return <div data-testid="blur" />; },
}));
vi.mock("@react-native-masked-view/masked-view", () => ({
  default: ({ children }: { children?: ReactNode }) => { mocks.maskRenders++; return <div data-testid="masked">{children}</div>; },
}));
vi.mock("expo-linear-gradient", () => ({
  LinearGradient: () => { mocks.gradientRenders++; return <div data-testid="gradient" />; },
}));
vi.mock("./theme", () => ({
  useTheme: () => ({ palette: { page: "#111111", card: "#222222", border: "#333333", ink: "#eeeeee", muted: "#888888", faint: "#666666", danger: "#ff0000", warning: "#ffaa00", accent: "#0088ff", accentInk: "#ffffff", raised: "#333333" } }),
}));
vi.mock("@mobile/ui/theme", () => ({
  useTheme: () => ({ palette: { page: "#111111", card: "#222222", border: "#333333", ink: "#eeeeee", muted: "#888888", faint: "#666666", danger: "#ff0000", warning: "#ffaa00", accent: "#0088ff", accentInk: "#ffffff", raised: "#333333" } }),
}));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({ logs: [] }) }));
vi.mock("@mobile/state/connection-log-store", () => ({
  useConnectionLogs: () => [
    { id: "1", at: Date.UTC(2026, 10, 28, 10, 0, 0), level: "info", message: "First" },
    { id: "2", at: Date.UTC(2026, 10, 28, 10, 0, 5), level: "warning", message: "Second" },
  ],
}));
vi.mock("@mobile/ui/primitives", () => ({
  Card: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StatusDot: () => null,
}));

const { Spinner, resetReduceMotionStoreForTests } = await import("./Spinner");
const { EdgeFade, resetReduceTransparencyStoreForTests } = await import("./EdgeFade");
const { SessionListRow } = await import("./SessionListRow");
const { CloudWorkspaceRow } = await import("./CloudWorkspaceRow");
const { RepositoryRow } = await import("./RepositoryRow");
const { default: ConnectionLogScreen } = await import("../../app/connection-log");
const { shortTime, spokenTime } = await import("../data/session-list");

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.os = "ios";
  mocks.reduceMotion = false;
  mocks.reduceTransparency = false;
  mocks.motionQueries = 0;
  mocks.transparencyQueries = 0;
  mocks.listeners.clear();
  mocks.removedListeners = 0;
  mocks.blurRenders = 0;
  mocks.maskRenders = 0;
  mocks.gradientRenders = 0;
  mocks.flatListCalls = 0;
  resetReduceMotionStoreForTests();
  resetReduceTransparencyStoreForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("P-86: shared AccessibilityInfo reduceMotion subscription in Spinner", () => {
  it("queries AccessibilityInfo once and shares a single native listener across many Spinners", async () => {
    await act(async () => {
      root.render(
        <div>
          <Spinner size={16} color="#fff" />
          <Spinner size={18} color="#fff" />
          <Spinner size={20} color="#fff" />
          <Spinner size={22} color="#fff" />
          <Spinner size={24} color="#fff" />
        </div>,
      );
    });
    expect(mocks.motionQueries).toBe(1);
    expect(mocks.listeners.get("reduceMotionChanged")?.size).toBe(1);

    await act(async () => root.unmount());
    expect(mocks.listeners.get("reduceMotionChanged")?.size).toBe(0);
    expect(mocks.removedListeners).toBe(1);
  });
});

describe("P-85: memoized EdgeFade with pure gradient fallback on Android and reduced transparency", () => {
  it("is memoized, uses BlurView on iOS, and falls back to pure LinearGradient on Android and reduced-transparency devices", async () => {
    expect((EdgeFade as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));

    await act(async () => root.render(<EdgeFade edge="bottom" height={80} />));
    expect(mocks.blurRenders).toBe(1);
    expect(mocks.maskRenders).toBe(1);

    // Android skips MaskedView + BlurView completely.
    mocks.blurRenders = 0;
    mocks.maskRenders = 0;
    mocks.gradientRenders = 0;
    mocks.os = "android";
    await act(async () => root.render(<EdgeFade edge="top" height={80} />));
    expect(mocks.blurRenders).toBe(0);
    expect(mocks.maskRenders).toBe(0);
    expect(mocks.gradientRenders).toBe(1);

    // iOS with reduced transparency also skips MaskedView + BlurView.
    mocks.os = "ios";
    mocks.blurRenders = 0;
    mocks.maskRenders = 0;
    mocks.gradientRenders = 0;
    await act(async () => {
      root.render(<EdgeFade edge="bottom" height={80} />);
      for (const listener of [...(mocks.listeners.get("reduceTransparencyChanged") ?? [])]) listener(true);
    });
    expect(container.querySelector('[data-testid="blur"]')).toBeNull();
    expect(container.querySelector('[data-testid="masked"]')).toBeNull();
    expect(container.querySelector('[data-testid="gradient"]')).not.toBeNull();
  });
});

describe("P-79: memoized rows, virtualized ConnectionLogScreen FlatList, and cached Intl.DateTimeFormat", () => {
  it("wraps SessionListRow, CloudWorkspaceRow, and RepositoryRow in React.memo", () => {
    const memoSymbol = Symbol.for("react.memo");
    expect((SessionListRow as unknown as { $$typeof?: symbol }).$$typeof).toBe(memoSymbol);
    expect((CloudWorkspaceRow as unknown as { $$typeof?: symbol }).$$typeof).toBe(memoSymbol);
    expect((RepositoryRow as unknown as { $$typeof?: symbol }).$$typeof).toBe(memoSymbol);
  });

  it("renders ConnectionLogScreen via FlatList in newest-first order", async () => {
    await act(async () => root.render(<ConnectionLogScreen />));
    expect(mocks.flatListCalls).toBe(1);
    const text = container.textContent ?? "";
    expect(text).toContain("2 entries");
    expect(text.indexOf("Second")).toBeLessThan(text.indexOf("First"));
  });

  it("formats session-list dates consistently via cached Intl.DateTimeFormat instances", () => {
    const now = Date.UTC(2026, 10, 28, 12, 0, 0);
    const threeDaysAgo = now - 3 * 24 * 3600_000;
    const twoMonthsAgo = Date.UTC(2026, 8, 15, 12, 0, 0);
    const lastYear = Date.UTC(2025, 5, 1, 12, 0, 0);
    expect(shortTime(threeDaysAgo, now).length).toBeGreaterThan(0);
    expect(shortTime(twoMonthsAgo, now).length).toBeGreaterThan(0);
    expect(shortTime(lastYear, now).length).toBeGreaterThan(0);
    expect(spokenTime(threeDaysAgo, now)).toMatch(/^active /);
  });
});
