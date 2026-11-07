import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionTable, type SessionTableRow } from "./SessionTable";
const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
afterEach(() => { cleanup(); openUrl.mockClear(); });

it("renders change counts, dates and missing values, and opens PR links without opening a session", () => {
  const row: SessionTableRow = { id: "one", status: "Done", name: "Feature", project: "API", branch: null, agent: "Codex", owner: "Amy", changes: 12, additions: 10, deletions: 2, pr: 9, prs: [
    { number: 9, url: "https://github.com/acme/api/pull/9", head: "feature", scope: { kind: "local", cwd: "/repo" } },
    { number: 10, url: "file:///tmp/example", head: "other", scope: { kind: "local", cwd: "/repo" } },
  ], updated: "2026-11-01T12:00:00Z", created: null };
  const onOpen = vi.fn();
  render(<SessionTable containerRef={createRef()} rows={[row]} hiddenColumns={[]} sort={{ column: "updated", direction: "desc" }} onSort={() => undefined} selectedId={null} onFocus={() => undefined} onOpen={onOpen} loading={false} />);
  expect(screen.getByText("+10")).toBeTruthy();
  expect(screen.getByText("−2")).toBeTruthy();
  expect(screen.getAllByText("—")).toHaveLength(2);
  expect(document.querySelector("time")?.dateTime).toBe("2026-11-01T12:00:00Z");
  fireEvent.click(screen.getByRole("button", { name: "Open PR #9" }));
  expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/api/pull/9");
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open PR #10" }));
  expect(openUrl).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("row", { name: /Feature/ }));
  expect(onOpen).toHaveBeenCalledWith("one");
});

it("windows large tables and moves keyboard focus across window edges with one active row", () => {
  const rows: SessionTableRow[] = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index), name: `Task ${index}`, status: "Working", project: "API", branch: "feature", agent: "Codex", owner: "Amy",
    changes: null, additions: null, deletions: null, pr: null, prs: [], updated: null, created: null,
  }));
  const containerRef = createRef<HTMLDivElement>();
  const navigationRef = createRef<import("./SessionTable").SessionTableHandle>();
  const onOpen = vi.fn();
  const props = { containerRef, navigationRef, rows, hiddenColumns: [], sort: { column: "name" as const, direction: "asc" as const }, onSort: vi.fn(), onFocus: vi.fn(), onOpen, loading: false };
  const view = render(<SessionTable {...props} selectedId={null} />);
  const rendered = () => containerRef.current!.querySelectorAll("tr[data-session]");
  const tabbable = () => containerRef.current!.querySelectorAll('tr[data-session][tabindex="0"]');
  expect(rendered().length).toBeLessThan(40);
  expect(tabbable()).toHaveLength(1);
  expect(screen.getByRole("table").getAttribute("aria-rowcount")).toBe("1001");
  expect(screen.getByRole("row", { name: /Task 0 / }).hasAttribute("aria-label")).toBe(false);
  act(() => {
    navigationRef.current!.focusRow("300");
    view.rerender(<SessionTable {...props} selectedId="300" />);
  });
  const selected = screen.getByRole("row", { name: /Task 300 / });
  expect(selected.getAttribute("aria-rowindex")).toBe("302");
  expect(document.activeElement).toBe(selected);
  expect(tabbable()).toHaveLength(1);
  expect(tabbable()[0]).toBe(selected);
  expect(rendered().length).toBeLessThan(40);
  fireEvent.keyDown(selected, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("300");
  // A pointer scroll away from selection still leaves one reachable row.
  containerRef.current!.scrollTop = 30_000;
  fireEvent.scroll(containerRef.current!);
  expect(tabbable()).toHaveLength(1);
  expect(rendered().length).toBeLessThan(40);
  act(() => {
    navigationRef.current!.focusRow("299");
    view.rerender(<SessionTable {...props} selectedId="299" />);
  });
  expect(document.activeElement).toBe(screen.getByRole("row", { name: /Task 299 / }));
});
