// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { scrollEdges } from "./MarkdownTable";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("./theme", () => ({ useTheme: () => ({ palette: {
  ink: "#222222", muted: "#777777", accent: "#a96f27", raised: "#eeeeee", border: "#cccccc", card: "#ffffff", page: "#fafafa",
} }) }));
// The gradient is native drawing; a marker stands in so the test can see where a fade is drawn.
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => <i data-gradient="" /> }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const HEADERS = ["Task", "Owner", "Status", "Due", "Estimate", "Notes"];
const ROWS = [
  ["Ship sync", "Alice", "Paused until Tue", "~Thu 19 Nov", "3 days", "Waiting on review from the platform team"],
  ["Fix relay", "Bob", "In progress", "Mon 16 Nov", "1 day", "Reproduced on the staging relay only"],
];
const SIX_COLUMNS = `| ${HEADERS.join(" | ")} |\n| ${HEADERS.map(() => "---").join(" | ")} |\n${ROWS.map((row) => `| ${row.join(" | ")} |`).join("\n")}`;

const render = async (text: string) => { await act(async () => root.render(<Markdown text={text} />)); };
const scroller = () => container.querySelector('[aria-label="Markdown table"]') as HTMLElement;
const fades = () => ({
  start: !!container.querySelector('[data-testid="table-fade-start"]'),
  end: !!container.querySelector('[data-testid="table-fade-end"]'),
});
// jsdom does no layout: say how wide the scroller and its content are, then scroll it.
async function scrollTo(offset: number, viewport = 340, content = 1080) {
  const node = scroller();
  Object.defineProperty(node, "offsetWidth", { configurable: true, value: viewport });
  Object.defineProperty(node, "scrollWidth", { configurable: true, value: content });
  node.scrollLeft = offset;
  await new Promise((resolve) => setTimeout(resolve, 20)); // past the scroll event throttle
  await act(async () => { node.dispatchEvent(new Event("scroll")); });
}

it("tells which sides of a scroller still hide content", () => {
  expect(scrollEdges(0, 340, 1080)).toEqual({ start: false, end: true });
  expect(scrollEdges(370, 340, 1080)).toEqual({ start: true, end: true });
  expect(scrollEdges(740, 340, 1080)).toEqual({ start: true, end: false });
  expect(scrollEdges(0, 340, 340)).toEqual({ start: false, end: false });
  expect(scrollEdges(0, 0, 0)).toEqual({ start: false, end: false });
});

it("starts a six-column table at its first column and fades only where more content exists", async () => {
  await render(SIX_COLUMNS);
  expect(scroller().scrollLeft).toBe(0);
  expect(scroller().textContent?.startsWith("TaskOwnerStatus")).toBe(true);

  await scrollTo(0);
  expect(scroller().scrollLeft).toBe(0);
  expect(fades()).toEqual({ start: false, end: true });

  await scrollTo(370);
  expect(fades()).toEqual({ start: true, end: true });

  await scrollTo(740);
  expect(fades()).toEqual({ start: true, end: false });

  await scrollTo(0, 340, 340);
  expect(fades()).toEqual({ start: false, end: false });
});

it("opens the table full screen with every cell, and closes it again", async () => {
  await render(SIX_COLUMNS);
  expect(document.querySelector('[aria-label="Expanded table"]')).toBeNull();
  const expand = container.querySelector('[aria-label="Expand table"]') as HTMLElement;
  expect(expand).not.toBeNull();
  await act(async () => { expand.click(); });

  const full = document.querySelector('[aria-label="Expanded table"]') as HTMLElement;
  expect(full).not.toBeNull();
  const cells = [...full.querySelectorAll("div")].map((node) => node.textContent);
  for (const text of [...HEADERS, ...ROWS.flat()]) expect(cells).toContain(text);
  expect(full.textContent).toBe([...HEADERS, ...ROWS.flat()].join(""));
  expect(full.textContent).not.toContain("|");
  // Cells may wrap: a long cell is a fixed-width column of wrapped text, not one cut line.
  const notes = [...full.querySelectorAll("div")].filter((node) => node.textContent === ROWS[0][5]).at(-1)!;
  expect(getComputedStyle(notes.parentElement!).width).toBe("150px");
  expect(getComputedStyle(notes).whiteSpace).not.toBe("nowrap");

  const close = document.querySelector('[aria-label="Close table"]') as HTMLElement;
  const animated = () => document.body.lastElementChild!.firstElementChild!;
  await act(async () => { close.click(); });
  // The slide-out ends with an animation event on the modal's own element; jsdom never fires it by itself.
  // jsdom has no AnimationEvent, so React listens under the prefixed name there.
  for (const name of ["animationend", "webkitAnimationEnd"]) await act(async () => { animated().dispatchEvent(new Event(name, { bubbles: true })); });
  expect(document.querySelector('[aria-label="Expanded table"]')).toBeNull();
});
