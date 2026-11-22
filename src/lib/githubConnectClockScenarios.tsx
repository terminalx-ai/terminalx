import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { CONNECT_POLL_BUDGET_MS } from "@/lib/useGithubConnectAttempt";

/**
 * Clock scenarios for useGithubConnectAttempt (#1323), run against each
 * consumer: the organization settings card and the cloud setup wizard.
 *
 * The desktop's wall clock (`Date.now`) is skewed and made to jump; the
 * monotonic clock (`performance.now`) is advanced separately. Only the server
 * may end an attempt as expired, and only the monotonic clock may bound it.
 */
export function githubConnectClockScenarios({
  api,
  begin,
  connected,
}: {
  api: { connect: Mock; attempt: Mock; summary: Mock };
  /** Renders the consumer and starts a connect attempt. */
  begin: () => Promise<void>;
  /** An installation the poll reports once the attempt connects. */
  connected: { id: string; accountLogin: string } & Record<string, unknown>;
}) {
  const realMonotonic = performance.now.bind(performance);
  const realWall = Date.now.bind(Date);
  const clocks = { monotonic: 0, wall: 0 };
  const skew = () => {
    clocks.monotonic = 0;
    clocks.wall = 0;
    vi.spyOn(performance, "now").mockImplementation(() => realMonotonic() + clocks.monotonic);
    vi.spyOn(Date, "now").mockImplementation(() => realWall() + clocks.wall);
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const HOUR = 60 * 60_000;
  // The server's expiry, on the server's clock: ten minutes from the real now.
  const serverExpiry = () => realWall() + 10 * 60_000;
  const waiting = (extra = {}) => ({ attemptId: "att_1", state: "waiting", browserOpened: false, expiresAt: serverExpiry(), ...extra });
  const pollsAtLeast = (count: number) => waitFor(() => expect(api.attempt.mock.calls.length).toBeGreaterThanOrEqual(count));
  const noExpiry = () => expect(screen.queryByText(/expired before it was confirmed/)).toBeNull();

  it.each([
    ["a day ahead", 24 * HOUR],
    ["an hour behind", -HOUR],
  ])("keeps a waiting attempt with the desktop clock %s, then shows the server's connected result", async (_label, offset) => {
    skew();
    clocks.wall = offset;
    api.connect.mockResolvedValue({ ...waiting(), browserOpened: true });
    api.attempt.mockResolvedValue(waiting());
    await begin();
    await pollsAtLeast(3);
    noExpiry();
    const loads = api.summary.mock.calls.length;
    api.attempt.mockResolvedValue({ attemptId: "att_1", state: "connected", browserOpened: false, installation: connected });
    await screen.findByText(new RegExp(`Connected ${connected.accountLogin}\\.`));
    await waitFor(() => expect(api.summary.mock.calls.length).toBeGreaterThan(loads));
  });

  it("keeps polling through a wall-clock jump and network failures, then shows the server's expiry", async () => {
    skew();
    api.connect.mockResolvedValue({ ...waiting(), browserOpened: true });
    api.attempt.mockResolvedValue(waiting());
    await begin();
    await pollsAtLeast(2);
    // The wall clock jumps a day forward, then the account service is unreachable for a while.
    clocks.wall = 24 * HOUR;
    api.attempt.mockRejectedValue({ code: "github_app_request_failed", status: null });
    const before = api.attempt.mock.calls.length;
    await pollsAtLeast(before + 3);
    noExpiry();
    expect(screen.queryByText(/stopped waiting for the account service/)).toBeNull();
    // Then the wall clock jumps back, and the server says the attempt expired.
    clocks.wall = -HOUR;
    api.attempt.mockResolvedValue({ attemptId: "att_1", state: "expired", browserOpened: false });
    await screen.findByText(/expired before it was confirmed/);
  });

  it("keeps polling an attempt the server still reports waiting past the 15 minutes its expiry message names, then shows the server's connected result", async () => {
    // The desktop's budget is its own policy, not the server's lifetime plus grace (#1370).
    const longServerLifetime = 20 * 60_000;
    expect(CONNECT_POLL_BUDGET_MS).toBeGreaterThan(longServerLifetime);
    skew();
    api.connect.mockResolvedValue({ ...waiting(), browserOpened: true });
    api.attempt.mockResolvedValue(waiting());
    await begin();
    await pollsAtLeast(2);
    clocks.monotonic = longServerLifetime;
    const before = api.attempt.mock.calls.length;
    await pollsAtLeast(before + 2);
    expect(screen.queryByText(/stopped waiting for the account service/)).toBeNull();
    noExpiry();
    api.attempt.mockResolvedValue({ attemptId: "att_1", state: "connected", browserOpened: false, installation: connected });
    await screen.findByText(new RegExp(`Connected ${connected.accountLogin}\\.`));
  });

  it("shows the expiry the server reports by refusing the poll", async () => {
    skew();
    api.connect.mockResolvedValue({ ...waiting(), browserOpened: true });
    api.attempt.mockRejectedValue({ code: "github_connect_attempt_expired", status: 410 });
    await begin();
    await screen.findByText(/expired before it was confirmed/);
    expect(screen.queryByText(/could not reach the account service/)).toBeNull();
  });

  it.each([
    ["keeps answering waiting", () => api.attempt.mockResolvedValue(waiting())],
    ["cannot be reached", () => api.attempt.mockRejectedValue({ code: "github_app_request_failed", status: null })],
  ])("stops checking without calling it expired when the server %s past the desktop's own cutoff, and re-reads the installations", async (_label, answer) => {
    skew();
    api.connect.mockResolvedValue({ ...waiting(), browserOpened: true });
    answer();
    await begin();
    await pollsAtLeast(2);
    noExpiry();
    const loads = api.summary.mock.calls.length;
    clocks.monotonic = CONNECT_POLL_BUDGET_MS + 1;
    await screen.findByText(/stopped waiting for the account service to confirm the connection/);
    noExpiry();
    // Reconciles: an installation that connected on the server shows up.
    await waitFor(() => expect(api.summary.mock.calls.length).toBeGreaterThan(loads));
    const polls = api.attempt.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.attempt.mock.calls.length).toBe(polls);
  });
}
