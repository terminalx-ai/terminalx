// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { stage } from "./testing/kit";
import { maxScaleFor, TextSizePage, textSizeScreenLayout, withTextSizePage } from "./text-size";

// PRO-601: a text size changed in Settings while the app is open shows at once, and headings stop at a size.
const mocks = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock("react-native", async () => ({ ...(await import("@mobile/ui/testing/native")), useWindowDimensions: () => ({ width: 375, height: 667, scale: 2, fontScale: mocks.fontScale }) }));

const page = stage();
beforeEach(() => { mocks.fontScale = 1; });

/** A page holding state of its own, as a tab with a typed search does. */
function Search() {
  const [query] = useState(() => `query-${Math.random()}`);
  return <span data-testid="search">{query}</span>;
}

it("puts its view of no size back at each new text size, and keeps the page and what it holds", async () => {
  await page.show(<TextSizePage><Search /></TextSizePage>);
  const relayout = page.byId("text-size-relayout");
  const search = page.byId("search");
  const query = search?.textContent;
  expect(relayout).not.toBeNull();

  // The same size again: nothing is put back, so nothing is laid out for no reason.
  await page.show(<TextSizePage><Search /></TextSizePage>);
  expect(page.byId("text-size-relayout")).toBe(relayout);

  mocks.fontScale = 3.571;
  await page.show(<TextSizePage><Search /></TextSizePage>);
  expect(page.byId("text-size-relayout")).not.toBe(relayout);
  expect(page.byId("search")).toBe(search);
  expect(page.byId("search")?.textContent).toBe(query);
});

it("is what a navigator's screenLayout draws each page in", async () => {
  await page.show(textSizeScreenLayout({ children: <Search /> }));
  expect(page.byId("search")).not.toBeNull();
  expect(page.byId("text-size-relayout")).not.toBeNull();
});

it("draws a tab's page in it, with the page's own props", async () => {
  const Tab = withTextSizePage(({ label }: { label: string }) => <span data-testid="tab">{label}</span>);
  await page.show(<Tab label="Machines" />);
  expect(page.byId("tab")?.textContent).toBe("Machines");
  const relayout = page.byId("text-size-relayout");
  expect(relayout).not.toBeNull();
  mocks.fontScale = 2;
  await page.show(<Tab label="Machines" />);
  expect(page.byId("text-size-relayout")).not.toBe(relayout);
});

it("stops text at a size in points, whatever size it is set at, and never draws it smaller", () => {
  expect(maxScaleFor(32, 42)).toBeCloseTo(1.3125);
  expect(maxScaleFor(17, 42) * 17).toBeCloseTo(42);
  expect(maxScaleFor(14, 21) * 14).toBeCloseTo(21);
  expect(maxScaleFor(48, 42)).toBe(1);
});
