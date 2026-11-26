import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionNudge } from "./SessionNudge";

const { send, showError, current } = vi.hoisted(() => ({ send: vi.fn(), showError: vi.fn(), current: { allowed: true } }));
function account() {
  return {
    status: {
      state: "signed-in",
      context: { revision: "rev-1" },
      phase2Readiness: current.allowed ? { "org-a": ["team.nudges.v1"] } : {},
    },
  };
}
vi.mock("@/lib/account", () => ({ useAccount: account, getAccount: account }));
vi.mock("@/lib/api", () => ({ api: { nudgeSend: send } }));
vi.mock("@/lib/errorToasts", () => ({ showError }));
vi.mock("@/lib/cloudTerminals", () => ({ errorCode: (error: { code?: string }) => error.code }));
vi.mock("@/lib/dataPrivacy", () => ({
  getDataPrivacy: () => ({ ready: true, enabled: false }),
  useDataPrivacy: () => ({ ready: true, enabled: false }),
}));

const session = { orgId: "org-a", workspaceId: "ws-1", sessionId: "session-1", title: "Update alerts" };

afterEach(() => {
  cleanup();
  current.allowed = true;
  vi.clearAllMocks();
});

it("sends the edited message with the session and gives a generic nondelivery result", async () => {
  send.mockResolvedValue({ delivered: false });
  render(<SessionNudge userId="u-2" session={session} />);
  fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
  const text = screen.getByRole("textbox", { name: "Nudge message" }) as HTMLTextAreaElement;
  expect(text.value).toBe("Could you take a look at this session?");
  fireEvent.change(text, { target: { value: " Can you check this? " } });
  fireEvent.click(screen.getByRole("button", { name: "Send nudge" }));
  await screen.findByText("Nudge not delivered.");
  expect(send).toHaveBeenCalledExactlyOnceWith("org-a", {
    targetUserId: "u-2", workspaceId: "ws-1", sessionId: "session-1", text: "Can you check this?",
  });
});

it("does not render the sender when organization readiness is held", () => {
  current.allowed = false;
  render(<SessionNudge userId="u-2" session={session} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it("shows the sender's rate-limit toast for the typed 429", async () => {
  send.mockRejectedValue({ status: 429, code: "nudge_rate_limited" });
  render(<SessionNudge userId="u-2" session={session} />);
  fireEvent.click(screen.getByRole("button", { name: "Nudge" }));
  fireEvent.click(screen.getByRole("button", { name: "Send nudge" }));
  await vi.waitFor(() => expect(showError).toHaveBeenCalledWith("Try again in a minute", undefined, expect.objectContaining({ title: "Too many nudges" })));
  expect(screen.queryByText("Nudge not delivered.")).toBeNull();
});
