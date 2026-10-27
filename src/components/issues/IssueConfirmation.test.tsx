import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueConfirmation, type IssueConfirmationRequest } from "./IssueConfirmation";

const { invoke, listen, store } = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), store: { navigationVersion: 1, selectedSessionId: "unrelated" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => store }));

let pending: IssueConfirmationRequest | null;
let changed: () => Promise<void>;
const request = (): IssueConfirmationRequest => ({
  id: "request-1", expiresAt: Date.now() + 40_000,
  question: {
    title: "Linear issue request", sessionId: "origin", sessionTitle: "Zeron comparison",
    project: "TerminalX", target: "PRO", summary: "Create the issue ‘Show truthful agent readiness’ in PRO",
    description: "## Readiness\n\n- [ ] Check readiness\n\n[Reference](https://example.com/" + "long-path/".repeat(250) + ")\n\n" + "Review this complete description.\n".repeat(30) + "END OF DESCRIPTION",
    agree: "Create issue",
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  store.navigationVersion = 1;
  store.selectedSessionId = "unrelated";
  pending = request();
  listen.mockImplementation((_event, callback) => { changed = callback; return Promise.resolve(vi.fn()); });
  invoke.mockImplementation(async (command) => command === "issue_confirmation_pending" ? pending : true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function review() {
  await screen.findByRole("button", { name: "Review" });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  return screen.findByRole("dialog");
}

describe("issue confirmation", () => {
  it("leaves focus and the unrelated conversation alone until Review is chosen", async () => {
    render(<><input aria-label="Conversation" /><IssueConfirmation /></>);
    const input = screen.getByRole("textbox");
    input.focus();
    await screen.findByRole("button", { name: "Review" });
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/Zeron comparison/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
  });

  it("renders long Markdown in a bounded keyboard-scrollable area with actions outside it", async () => {
    render(<IssueConfirmation />);
    const dialog = await review();
    const details = within(dialog).getByRole("group", { name: "Issue request details" });
    expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog.className).toContain("flex-col");
    expect(details.className).toContain("overflow-y-auto");
    expect(details.tabIndex).toBe(0);
    expect(within(details).getByRole("heading", { name: "Readiness" })).toBeTruthy();
    expect(within(details).getByRole("checkbox")).toBeTruthy();
    expect(details.textContent).toContain("END OF DESCRIPTION");
    expect(details.textContent).toContain("long-path/".repeat(250));
    expect(within(details).getByText("PRO")).toBeTruthy();
    expect(within(details).getByText("origin")).toBeTruthy();
    const cancel = within(dialog).getByRole("button", { name: "Cancel request" });
    const approve = within(dialog).getByRole("button", { name: "Create issue" });
    expect(details.contains(cancel)).toBe(false);
    expect(details.contains(approve)).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
  });

  it("hides a review on navigation without answering or reopening it on return", async () => {
    const view = render(<IssueConfirmation />);
    await review();
    store.selectedSessionId = "another";
    store.navigationVersion++;
    view.rerender(<IssueConfirmation />);
    expect(screen.queryByRole("dialog")).toBeNull();
    store.selectedSessionId = "unrelated";
    store.navigationVersion++;
    view.rerender(<IssueConfirmation />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
  });

  it.each([true, false])("sends only the explicit decision (%s) with its request id", async (approved) => {
    render(<IssueConfirmation />);
    await review();
    fireEvent.click(screen.getByRole("button", { name: approved ? "Create issue" : "Cancel request" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("issue_confirmation_reply", { id: "request-1", approved }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape dismisses review without approving or cancelling the pending request", async () => {
    render(<IssueConfirmation />);
    await review();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
  });

  it("removes an expired request without approving it", async () => {
    render(<IssueConfirmation />);
    await review();
    pending = null;
    await act(() => changed());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
  });

  it("keeps failed decisions visible and requires another explicit action", async () => {
    render(<IssueConfirmation />);
    await review();
    invoke.mockRejectedValueOnce(new Error("Disconnected"));
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(invoke.mock.calls.filter(([command]) => command === "issue_confirmation_reply")).toHaveLength(1);
  });
});
