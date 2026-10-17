// @vitest-environment jsdom
import { act, cloneElement, isValidElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptList } from "./TranscriptList";

const flipped = (style: any): boolean => [style].flat(Infinity).some((part) => part?.transform?.some?.((step: any) => step.scaleY === -1));

vi.mock("./theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("react-native", () => {
  const View = ({ children, style }: { children?: ReactNode; style?: unknown }) => <div data-flipped={flipped(style) || undefined}>{children}</div>;
  return {
    View, Text: View, Pressable: View,
    StyleSheet: { create: (styles: unknown) => styles, compose: (a: unknown, b: unknown) => (a && b ? [a, b] : a ?? b) },
    // Like VirtualizedList: an inverted list flips its scroll view and counter-flips
    // the empty element by cloning it with the inversion added to its `style`.
    FlatList: ({ data, inverted, ListEmptyComponent }: any) => {
      const inversion = inverted ? { transform: [{ scaleY: -1 }] } : null;
      const element = isValidElement<any>(ListEmptyComponent) ? ListEmptyComponent : ListEmptyComponent ? <ListEmptyComponent /> : null;
      return <div data-flipped={inverted || undefined}>{!data.length && element ? cloneElement(element, { style: [inversion, element.props.style] }) : null}</div>;
    },
  };
});

// Like the app's EmptyState: it takes no `style` prop.
const Empty = ({ title }: { title: string }) => <p>{title}</p>;

let root: Root;
let container: HTMLDivElement;
const upright = (text: string) => {
  const node = [...container.querySelectorAll("p")].find((item) => item.textContent === text);
  if (!node) throw new Error(`Not rendered: ${text}`);
  let flips = 0;
  for (let at: Element | null = node; at && at !== container; at = at.parentElement) if (at.hasAttribute("data-flipped")) flips += 1;
  return flips % 2 === 0;
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); });

describe("TranscriptList empty state", () => {
  it("draws an empty element that ignores style upright inside the inverted list", () => {
    act(() => root.render(<TranscriptList data={[]} renderItem={() => null} ListEmptyComponent={<Empty title="No conversation yet" />} />));
    expect(upright("No conversation yet")).toBe(true);
  });

  it("draws an empty component type upright too", () => {
    const NotReadable = () => <Empty title="Not readable on this phone yet" />;
    act(() => root.render(<TranscriptList data={[]} renderItem={() => null} ListEmptyComponent={NotReadable} />));
    expect(upright("Not readable on this phone yet")).toBe(true);
  });
});
