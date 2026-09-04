import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMark, KNOWN_AGENT_IDS, agentName } from "./AgentMark";

afterEach(cleanup);

describe("AgentMark", () => {
  it("maps every supported and historical agent to a distinct brand mark", () => {
    const { container } = render(
      <>{KNOWN_AGENT_IDS.map((id) => <AgentMark key={id} id={id} />)}</>,
    );

    expect(KNOWN_AGENT_IDS).toEqual(["claude", "codex", "cursor", "opencode"]);
    expect(KNOWN_AGENT_IDS.map(agentName)).toEqual(["Claude Code", "Codex", "Cursor", "OpenCode"]);
    const marks = [...container.querySelectorAll<SVGElement>('[data-agent-icon="brand"]')];
    expect(marks).toHaveLength(KNOWN_AGENT_IDS.length);
    expect(new Set(marks.map((mark) => mark.querySelector("path")?.getAttribute("d"))).size).toBe(KNOWN_AGENT_IDS.length);
  });

  it("gives an icon-only mark its accessible agent name", () => {
    render(<AgentMark id="claude" className="size-3" />);

    const mark = screen.getByRole("img", { name: "Claude Code" });
    expect(mark.classList.contains("size-3")).toBe(true);
    expect(mark.getAttribute("fill")).toBe("currentColor");
    expect(mark.getAttribute("focusable")).toBe("false");
  });

  it("hides a decorative mark when the visible name is beside it", () => {
    const { container } = render(<div><AgentMark id="codex" decorative /><span>Codex</span></div>);

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("uses a neutral, labelled fallback for unknown and empty identifiers", () => {
    const { container, rerender } = render(<AgentMark id="future-agent" />);

    expect(screen.getByRole("img", { name: "future-agent" })).toBeTruthy();
    expect(container.querySelector('[data-agent-icon="fallback"]')).toBeTruthy();

    rerender(<AgentMark id="" />);
    expect(screen.getByRole("img", { name: "Unknown agent" })).toBeTruthy();
    expect(container.querySelector('[data-agent-id="unknown"]')).toBeTruthy();
  });

  it("keeps all marks vector-based and aligned in compact stacked states", () => {
    const { container } = render(
      <div className="flex -space-x-1 text-muted-foreground opacity-50">
        {KNOWN_AGENT_IDS.map((id) => <AgentMark key={id} id={id} className="size-3 rounded-full bg-background" />)}
        <AgentMark id="future-agent" className="size-3 rounded-full bg-background" />
      </div>,
    );

    for (const mark of container.querySelectorAll("svg")) {
      expect(mark.classList.contains("size-3")).toBe(true);
      expect(mark.classList.contains("shrink-0")).toBe(true);
      expect(mark.getAttribute("viewBox")).toBeTruthy();
    }
  });
});
