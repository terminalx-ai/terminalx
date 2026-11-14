import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { Turn } from "@/lib/transcript";
import { PromptMap, shortTime } from "./PromptMap";

afterEach(cleanup);

const turn = (key: string, text?: string): Turn => ({
  key,
  seq: 0,
  ts: "",
  prompt: text === undefined ? undefined : { text, ts: "", seq: 0 },
  work: [],
  toolCount: 0,
  editedFiles: 0,
  live: false,
});

describe("the prompt map", () => {
  it("has a mark per prompt, shows a prompt on hover and goes to its turn on click", () => {
    const scroller = createRef<HTMLDivElement>();
    const onJump = vi.fn();
    render(
      <>
        <div ref={scroller} />
        <PromptMap turns={[turn("a", "Fix the login page"), turn("b"), turn("c", "Now add tests\nfor it"), turn("d", "  ")]} scroller={scroller} onJump={onJump} />
      </>,
    );
    const marks = screen.getAllByRole("button");
    // A turn with no prompt, or an empty one, has no mark.
    expect(marks.map((mark) => mark.getAttribute("aria-label"))).toEqual(["Prompt 1: Fix the login page", "Prompt 2: Now add tests\nfor it"]);
    fireEvent.mouseEnter(marks[1]);
    expect(screen.getByRole("tooltip").textContent).toBe("Now add tests\nfor it");
    fireEvent.click(marks[1]);
    expect(onJump).toHaveBeenCalledWith("c");
  });

  it("is not drawn for a single prompt", () => {
    const scroller = createRef<HTMLDivElement>();
    render(<PromptMap turns={[turn("a", "Only one")]} scroller={scroller} onJump={() => undefined} />);
    expect(screen.queryByTestId("prompt-map")).toBeNull();
  });
});

describe("a prompt's time on the map", () => {
  it("shows when it was sent above its preview", () => {
    const scroller = createRef<HTMLDivElement>();
    const sent = turn("a", "Fix the login page");
    sent.prompt!.messageTs = new Date().toISOString();
    render(
      <>
        <div ref={scroller} />
        <PromptMap turns={[sent, turn("b", "Now add tests")]} scroller={scroller} onJump={() => undefined} />
      </>,
    );
    fireEvent.mouseEnter(screen.getAllByRole("button")[0]);
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(sent.prompt!.messageTs!).toISOString());
    expect(tip.textContent).toContain("Fix the login page");
  });

  it("is as short as it can be: the time today, the weekday this week, else the date", () => {
    const now = new Date("2026-11-06T18:00:00");
    expect(shortTime(new Date("2026-11-06T10:54:00").toISOString(), now, "en-US")?.label).toBe("10:54 AM");
    expect(shortTime(new Date("2026-11-02T22:54:00").toISOString(), now, "en-US")?.label).toBe("Mon 10:54 PM");
    expect(shortTime(new Date("2026-10-26T22:54:00").toISOString(), now, "en-US")?.label).toBe("Oct 26");
    expect(shortTime(undefined, now)).toBeNull();
  });
});
