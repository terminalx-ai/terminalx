import "@testing-library/dom";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueWorker } from "@/lib/issueWork";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

const { IssueWorkChip, IssueWorkPanel, TakenIssueDialog } = await import("./IssueWork");

async function cleanupIssueDialogs() {
  // Radix dispatches this event on the retained dialog in its deferred
  // unmount callback. Observe it before cleanup detaches the element.
  const unmounted = screen.queryAllByRole("dialog").map((dialog) =>
    new Promise<void>((resolve) => {
      dialog.addEventListener("focusScope.autoFocusOnUnmount", () => resolve(), { once: true });
    }),
  );
  await act(async () => {
    cleanup();
    await Promise.all(unmounted);
  });
}

afterEach(cleanupIssueDialogs);

const NOW = Date.parse("2026-10-18T12:00:00Z");

function worker(patch: Partial<IssueWorker>): IssueWorker {
  return { key: "k", place: "team", you: false, person: "Alice", machine: null, cloud: false, title: "Alice's session", branch: "alice/11", state: "working", phase: "now", since: NOW - 3600000, lastActive: NOW - 300000, sessionId: null, link: null, ...patch };
}

it("finishes the dialog's deferred unmount before cleanup resolves", async () => {
  render(<TakenIssueDialog workers={[worker({})]} onStart={() => {}} onCancel={() => {}} onOpen={null} />);
  const dialog = screen.getByRole("dialog");
  const unmounted = vi.fn();
  dialog.addEventListener("focusScope.autoFocusOnUnmount", unmounted);
  const completion = cleanupIssueDialogs();
  expect(dialog.isConnected).toBe(false);
  expect(unmounted).not.toHaveBeenCalled();
  await completion;
  expect(unmounted).toHaveBeenCalledTimes(1);
  const event = unmounted.mock.calls[0][0] as Event;
  expect(event).toBeInstanceOf(Event);
  expect(event.target).toBe(dialog);
  // Radix's modal close handler runs after our listener and prevents the
  // default focus restoration. It too must have run before cleanup resolves.
  expect(event.defaultPrevented).toBe(true);
});

describe("the work chip", () => {
  it("shows the first and how many more, and each one in full on hover", () => {
    render(<IssueWorkChip now={NOW} workers={[worker({}), worker({ key: "m", place: "machine", you: true, person: "You", machine: "Studio", state: "waiting" }), worker({ key: "t", place: "this", you: true, person: "You", machine: "this Mac", phase: "faded", state: "idle", lastActive: NOW - 7200000, sessionId: "s1", link: "branch" })]} />);
    const chip = screen.getByTestId("issue-work-chip");
    expect(chip.textContent).toBe("Alice · working+2");
    const detail = screen.getByRole("tooltip").textContent!;
    expect(detail).toContain("Agent working · last active 5 minutes ago");
    expect(detail).toContain("You · Studio");
    expect(detail).toContain("Waiting for an answer");
    expect(detail).toContain("Was working on this, 2 hours ago · linked from its branch name");
    // A teammate's machine is never named.
    expect(screen.getAllByTestId("issue-worker")[0].textContent).toBe("AliceAlice's sessionalice/11Agent working · last active 5 minutes ago");
  });

  it("fades work that went quiet", () => {
    render(<IssueWorkChip now={NOW} workers={[worker({ phase: "faded", lastActive: NOW - 3 * 3600000 })]} />);
    expect(screen.getByTestId("issue-work-chip").textContent).toBe("Alice · 3 hours ago");
    // Not in its hover card, over the rows below (#713): the line says so.
    const row = screen.getByTestId("issue-worker");
    expect(row.className).not.toContain("opacity-70");
    expect(row.textContent).toContain("Was working on this, 3 hours ago");
  });

  it("dims work that went quiet in the detail pane", () => {
    render(<IssueWorkPanel now={NOW} workers={[worker({ phase: "faded", lastActive: NOW - 3 * 3600000 })]} />);
    expect(screen.getByTestId("issue-worker").className).toContain("opacity-70");
  });
});

describe("the warning before starting on a taken issue", () => {
  it("is a warning, not a lock", () => {
    const onStart = vi.fn();
    const onOpen = vi.fn();
    const onCancel = vi.fn();
    render(<TakenIssueDialog now={NOW} workers={[worker({ key: "t", place: "this", you: true, person: "You", machine: "this Mac", sessionId: "s1" })]} onStart={onStart} onOpen={onOpen} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the existing session" }));
    expect(onOpen).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "Start anyway" }));
    expect(onStart).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

it("opens only an own cloud navigation target, never a claim or teammate as a local session", () => {
  const onOpen = vi.fn();
  const onOpenCloud = vi.fn();
  const cloudSession = { key: "cloud:org:workspace:author", tabId: "author-tab" };
  const { rerender } = render(<TakenIssueDialog workers={[worker({ place: "cloud", you: true, cloudSession })]} onStart={() => {}} onCancel={() => {}} onOpen={onOpen} onOpenCloud={onOpenCloud} />);
  fireEvent.click(screen.getByRole("button", { name: "Open the existing session" }));
  expect(onOpenCloud).toHaveBeenCalledWith(cloudSession.key, cloudSession.tabId);
  expect(onOpen).not.toHaveBeenCalled();
  rerender(<TakenIssueDialog workers={[worker({ place: "team", cloudSession })]} onStart={() => {}} onCancel={() => {}} onOpen={onOpen} onOpenCloud={onOpenCloud} />);
  expect(screen.queryByRole("button", { name: "Open the existing session" })).toBeNull();
});
