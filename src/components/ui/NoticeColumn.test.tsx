import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InNoticeColumn, NoticeColumn } from "./NoticeColumn";

type Box = { left: number; right: number; top: number; bottom: number };
const rect = (box: Box) => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box }) as DOMRect;

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

function composer(box: Box) {
  const element = document.createElement("div");
  element.setAttribute("data-composer-box", "");
  element.getBoundingClientRect = () => rect(box);
  document.body.append(element);
}

const columnOf = (text: string) => screen.getByText(text).closest("[data-notice-column]")?.getAttribute("data-notice-column");

function mount() {
  render(<NoticeColumn waiting={<div>Notifications are off</div>}><div>Claude Code finished</div></NoticeColumn>);
}

// #1499 at 1440×900 with the right panel closed: the chat's composer (x 494–1214) reaches under the corner (x 1044–1424).
it("puts the toasts top right, with the notices that wait, when a composer reaches under the bottom corner", () => {
  composer({ left: 494, right: 1214, top: 775, bottom: 860 });
  mount();
  expect(columnOf("Claude Code finished")).toBe("top");
  expect(columnOf("Notifications are off")).toBe("top");
});

it("stops the top column above the composer, so a tall stack scrolls instead of covering Send", () => {
  composer({ left: 494, right: 1214, top: 775, bottom: 860 });
  mount();
  const top = screen.getByText("Claude Code finished").closest<HTMLElement>("[data-notice-column]")!;
  expect(top.style.maxHeight).toBe(`${775 - 88 - 8}px`);
  expect(top.className).toContain("overflow-y-auto");
});

// A settings or issues page: its own controls are up top, so the toasts keep the bottom corner.
it("keeps the toasts in the bottom corner when no composer is under it", () => {
  mount();
  expect(columnOf("Claude Code finished")).toBe("bottom");
  expect(columnOf("Notifications are off")).toBe("top");
});

it("keeps them in the bottom corner over the right panel, where no composer reaches", () => {
  composer({ left: 494, right: 1000, top: 775, bottom: 860 });
  mount();
  expect(columnOf("Claude Code finished")).toBe("bottom");
});

it("moves them up when a composer comes under the corner", () => {
  vi.useFakeTimers();
  try {
    mount();
    expect(columnOf("Claude Code finished")).toBe("bottom");
    composer({ left: 494, right: 1214, top: 775, bottom: 860 });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(columnOf("Claude Code finished")).toBe("top");
  } finally {
    vi.useRealTimers();
  }
});

it("takes a notice raised deep in a page in with the toasts, after them", () => {
  render(<>
    <NoticeColumn><div>Claude Code finished</div></NoticeColumn>
    <main><InNoticeColumn><div role="alert">Can't save settings</div></InNoticeColumn></main>
  </>);
  const stack = screen.getByText("Claude Code finished").parentElement!;
  expect(stack.lastElementChild).toBe(screen.getByRole("alert"));
});

it("takes the bottom corner on its own when the page has no notice column", () => {
  render(<InNoticeColumn><div role="alert">Can't save settings</div></InNoticeColumn>);
  const own = screen.getByRole("alert").parentElement!;
  expect(own.className).toContain("bottom-8");
  expect(own.className).toContain("right-4");
});
