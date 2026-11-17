import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentName } from "@terminalx/portable/agentMarks";
import type { CloudTabRow } from "@/lib/cloudSessionTabs";
import { CloudSessionTabRows } from "./CloudSessionTabRows";

const tabs: CloudTabRow[] = [
  { tabId: "t1", harness: "codex", label: "Codex", status: "in_progress", front: false },
  { tabId: "t2", harness: "claude", label: "Fix the build", status: "completed", front: true },
  { tabId: "t3", harness: "codex", label: "Review", status: "waiting", front: false },
];

afterEach(cleanup);

function renderRows(over: { sessionSelected?: boolean; tabs?: CloudTabRow[]; onOpen?: (id: string) => void } = {}) {
  return render(<CloudSessionTabRows sessionTitle="Ship it" tabs={over.tabs ?? tabs} sessionSelected={over.sessionSelected ?? true} onOpen={over.onOpen ?? (() => undefined)} />);
}

describe("CloudSessionTabRows", () => {
  it("is a tree named after the session", () => {
    renderRows();
    const tree = screen.getByRole("tree", { name: "Tabs of Ship it" });
    expect(tree.getAttribute("data-testid")).toBe("cloud-session-tabs");
  });

  it("draws one row per tab, in order, with its label", () => {
    renderRows();
    const rows = screen.getAllByTestId("cloud-session-tab-row");
    expect(rows.map((row) => row.getAttribute("data-tab"))).toEqual(["t1", "t2", "t3"]);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Codex", "Fix the build", "Review"]);
    expect(within(screen.getByRole("tree")).getAllByRole("treeitem")).toHaveLength(3);
  });

  it("gives each row its status label and its agent's name", () => {
    renderRows();
    const rows = screen.getAllByTestId("cloud-session-tab-row");
    expect(within(rows[0]).getByRole("img", { name: "Working" })).toBeTruthy();
    expect(within(rows[1]).getByRole("img", { name: "Completed" })).toBeTruthy();
    expect(within(rows[2]).getByRole("img", { name: "Needs attention" })).toBeTruthy();
    expect(rows.map((row) => row.getAttribute("aria-description"))).toEqual([agentName("codex"), agentName("claude"), agentName("codex")]);
  });

  it("marks the front row selected only while the session is selected", () => {
    const { unmount } = renderRows({ sessionSelected: true });
    expect(screen.getAllByTestId("cloud-session-tab-row").map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    unmount();
    renderRows({ sessionSelected: false });
    expect(screen.getAllByTestId("cloud-session-tab-row").map((row) => row.getAttribute("aria-selected"))).toEqual(["false", "false", "false"]);
  });

  it("opens the row's tab on click and on Enter", () => {
    const onOpen = vi.fn();
    renderRows({ onOpen });
    const rows = screen.getAllByTestId("cloud-session-tab-row");
    fireEvent.click(rows[0]);
    expect(onOpen).toHaveBeenLastCalledWith("t1");
    fireEvent.keyDown(rows[2], { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("t3");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("draws no close button", () => {
    renderRows();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing for an empty list", () => {
    const { container } = renderRows({ tabs: [] });
    expect(container.firstChild).toBeNull();
  });
});
