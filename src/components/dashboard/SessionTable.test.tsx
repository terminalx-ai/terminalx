import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  fireEvent.click(screen.getByRole("row", { name: "Feature" }));
  expect(onOpen).toHaveBeenCalledWith("one");
});
