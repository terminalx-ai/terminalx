import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatus } from "@terminalx/portable/sessionStatus";
import { StatusBadge, StatusMarkIcon } from "./SessionStatus";
import { Working } from "./StatusMark";
import { PieceStateIcon } from "@/components/orchestration/PieceStateMark";
import { LeadTrailing, type LeadFamily, type LeadSummary } from "@/components/layout/RunRows";
import { RaccoonRunner, RaccoonScene } from "@/components/raccoon/Raccoon";
import { getPrefs, setPrefs } from "@/lib/prefs";

/**
 * PRO-366: the Pixel raccoon switch hides the raccoon only. Progress signs move
 * while the work goes on and stand still only under the system's Reduce motion.
 */

type Listener = () => void;
let reduced = false;
const listeners = new Set<Listener>();
function setReduced(value: boolean) {
  reduced = value;
  act(() => listeners.forEach((listener) => listener()));
}

const working = sessionStatus({ tabs: [{ status: "in_progress" }] });
const leadFamily = { lead: { id: "lead" }, workers: [], run: null, rows: [] } as unknown as LeadFamily;
const leadSummary = { needs: [], ownNeeds: [], running: 2, unread: false, progress: null, spend: null, statusOf: () => working } as unknown as LeadSummary;

function Marks() {
  return <>
    <StatusMarkIcon status={working} />
    <StatusBadge status={working} />
    <PieceStateIcon state="running" />
    <LeadTrailing family={leadFamily} folded summary={leadSummary} fallback={<span />} />
    <Working />
  </>;
}

function spinning(): boolean[] {
  return [
    ...screen.getAllByTestId("status-working").map((mark) => mark.querySelector("svg")!),
    screen.getByRole("img", { name: "Running" }).querySelector("svg")!,
    screen.getByTestId("lead-running").querySelector("svg")!,
  ].map((svg) => svg.classList.contains("animate-spin"));
}

const before = getPrefs().animations;
beforeEach(() => {
  reduced = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query.includes("reduced-motion") && reduced; },
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  }));
  setPrefs({ animations: false });
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.unstubAllGlobals();
  setPrefs({ animations: before });
});

describe("working marks", () => {
  it("turn with Pixel raccoon off: the session mark, a running piece and the lead's running count", () => {
    expect(working.icon).toBe("working");
    render(<Marks />);
    expect(spinning()).toEqual([true, true, true, true]);
  });

  it("keep the Working bars rising and falling with Pixel raccoon off", () => {
    render(<Working />);
    const mark = screen.getByTestId("working-mark");
    expect(mark.getAttribute("data-animated")).toBe("true");
    expect(mark.querySelectorAll("animate")).toHaveLength(3);
  });

  it("stand still under the system's Reduce motion, whatever the switch says, and move again when it is off", () => {
    for (const animations of [false, true]) {
      setPrefs({ animations });
      reduced = true;
      render(<Marks />);
      expect(spinning()).toEqual([false, false, false, false]);
      const bars = screen.getByTestId("working-mark");
      expect(bars.getAttribute("data-animated")).toBeNull();
      expect(bars.querySelectorAll("animate")).toHaveLength(0);
      setReduced(false);
      expect(spinning()).toEqual([true, true, true, true]);
      expect(screen.getByTestId("working-mark").querySelectorAll("animate")).toHaveLength(3);
      cleanup();
    }
  });
});

describe("Pixel raccoon off", () => {
  it("still removes the raccoon from the empty session and the composer", () => {
    const { container } = render(<><RaccoonScene /><RaccoonRunner active obstacle={false} /></>);
    expect(container.querySelector("canvas")).toBeNull();
  });
});
