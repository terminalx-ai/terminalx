import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastCorner } from "./ToastCorner";

type Box = { left: number; right: number; top: number; bottom: number };
const rect = (box: Box) => ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box }) as DOMRect;

let observers: (() => void)[] = [];
beforeEach(() => {
  observers = [];
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) { observers.push(() => this.callback()); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// At 1440×900 with the right panel closed (PRO-386): the 360×116 toast at x 1064–1424, y 752–868 lay over the
// composer (x 494–1214, y ~775–860) and its Send button.
function layout(composer: Box | null) {
  document.body.innerHTML = "";
  if (composer) {
    const box = document.createElement("div");
    box.setAttribute("data-composer-box", "");
    box.getBoundingClientRect = () => rect(composer);
    document.body.append(box);
  }
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-toast-corner") ? 116 : 0;
  });
}

function mount() {
  render(<ToastCorner><div>Something went wrong</div></ToastCorner>);
  const corner = screen.getByText("Something went wrong").parentElement!;
  corner.getBoundingClientRect = () => {
    const lift = Number(/translateY\(-(\d+)px\)/.exec(corner.style.transform)?.[1] ?? 0);
    return rect({ left: 1064, right: 1424, top: 752 - lift, bottom: 868 - lift });
  };
  act(() => { for (const observer of observers) observer(); });
  return corner;
}

it("rises clear of a composer under the corner, whatever it shows", () => {
  layout({ left: 494, right: 1214, top: 775, bottom: 860 });
  const corner = mount();
  // Clear of the composer's top with the indicator's clearance, so nothing of the toast covers Send.
  expect(corner.style.transform).toBe("translateY(-101px)");
});

it("stays put over the right panel, where no composer reaches", () => {
  layout({ left: 494, right: 1000, top: 775, bottom: 860 });
  expect(mount().style.transform).toBe("");
});
