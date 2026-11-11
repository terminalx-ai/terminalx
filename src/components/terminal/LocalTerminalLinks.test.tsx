import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalTerminalLinks } from "./LocalTerminalLinks";

const api = vi.hoisted(() => ({ localLinks: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/api", () => ({ pty: { localLinks: api.localLinks }, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: api.open }));
const links = { sessionId: "owner", cwd: "/repo/worktree", urls: ["http://localhost:20000/", "http://localhost:20001/app"] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  api.localLinks.mockResolvedValue(links);
  api.open.mockResolvedValue("browser-page");
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opens the detected URL in the owning session's TerminalX browser only on a click", async () => {
  await act(async () => { render(<LocalTerminalLinks id="pane" active />); });
  expect(api.localLinks).toHaveBeenCalledWith("pane");
  expect(api.open).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: `Open ${links.urls[1]}` })));
  expect(api.open).toHaveBeenCalledExactlyOnceWith("owner", "/repo/worktree", links.urls[1]);
});

it("polls visible panes without overlapping calls and forgets stale results when switching", async () => {
  let resolve!: (value: typeof links) => void;
  api.localLinks.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<LocalTerminalLinks id="old" active />);
  await act(async () => { vi.advanceTimersByTime(9000); });
  expect(api.localLinks).toHaveBeenCalledTimes(1);
  await act(async () => { view.rerender(<LocalTerminalLinks id="new" active />); });
  api.localLinks.mockResolvedValue(null);
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => { resolve(links); });
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<LocalTerminalLinks id="new" active={false} />);
  api.localLinks.mockClear();
  await act(async () => { vi.advanceTimersByTime(9000); });
  expect(api.localLinks).not.toHaveBeenCalled();
});

it("reports browser errors and allows retry, while preventing duplicate opens", async () => {
  let reject!: (error: Error) => void;
  api.open.mockImplementationOnce(() => new Promise((_, failed) => { reject = failed; }));
  await act(async () => { render(<LocalTerminalLinks id="pane" active />); });
  const button = screen.getByRole("button", { name: `Open ${links.urls[0]}` });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.open).toHaveBeenCalledTimes(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { reject(new Error("Browser unavailable")); });
  expect(screen.getByRole("alert").textContent).toContain("Browser unavailable");
  await act(async () => { fireEvent.click(button); });
  expect(api.open).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("hides links if the owning runtime disconnects or does not support discovery", async () => {
  await act(async () => { render(<LocalTerminalLinks id="pane" active />); });
  expect(screen.getAllByRole("button")).toHaveLength(2);
  api.localLinks.mockRejectedValue(new Error("unsupported local terminal operation"));
  await act(async () => { vi.advanceTimersByTime(3000); });
  expect(screen.queryByRole("button")).toBeNull();
});

it("does not show a previous pane's browser error after switching panes", async () => {
  let reject!: (error: Error) => void;
  api.open.mockImplementationOnce(() => new Promise((_, failed) => { reject = failed; }));
  const view = render(<LocalTerminalLinks id="old" active />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: `Open ${links.urls[0]}` }));
  await act(async () => { view.rerender(<LocalTerminalLinks id="new" active />); });
  await act(async () => { reject(new Error("Old browser error")); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getAllByRole("button")[0] as HTMLButtonElement).disabled).toBe(false);
});
