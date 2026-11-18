import { afterEach, expect, it, vi } from "vitest";
import { dismissError, getErrorToasts } from "./errorToasts";
import { githubReason, showFixFailed, showRerunFailed } from "./checkToasts";
import { checkLine, checkTime, durationLabel } from "./checks";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
afterEach(() => { for (const toast of getErrorToasts()) dismissError(toast.id); });

it.each([
  ["gh run rerun 1 --repo o/r --failed: run 1 cannot be rerun; its workflow file may be broken (HTTP 403)", "Run 1 cannot be rerun; its workflow file may be broken."],
  ["error: GitHub only re-runs jobs from the latest run", "GitHub only re-runs jobs from the latest run."],
  ["The log for lint / eslint didn't download: GitHub timed out after 30 s", "The log for lint / eslint didn't download: GitHub timed out after 30 s."],
  ["gh run rerun 1 --repo o/r:\nHTTP 422: Unprocessable Entity\nThis run is not done yet.", "This run is not done yet."],
  ["", "GitHub didn't say why."],
])("says GitHub's reason for %j as one sentence", (message, said) => {
  expect(githubReason(message)).toBe(said);
});

it("names the PR, says GitHub's reason and links its run, without Copy error (PRO-394, 05.17)", () => {
  showRerunFailed({ prNumber: 781, error: "run 11873421 cannot be rerun (HTTP 403)", runUrl: "https://github.com/o/r/actions/runs/11873421" });
  expect(getErrorToasts()).toEqual([expect.objectContaining({ title: "Couldn't re-run checks on #781", action: "Run 11873421 cannot be rerun", tone: "error", copy: false })]);
  expect(getErrorToasts()[0].actions?.map((action) => action.label)).toEqual(["Open run on GitHub"]);
});

it("says nothing reached the agent, with Try again first and the log on GitHub", () => {
  const retry = vi.fn();
  showFixFailed({ key: "s", error: "The log for lint / eslint didn't download: GitHub timed out after 30 s", retry, logUrl: "https://github.com/o/r/actions/runs/1/job/2" });
  showFixFailed({ key: "s", error: "Again", retry });
  // Raised again for the same session, it is one toast, updated.
  expect(getErrorToasts()).toHaveLength(1);
  showFixFailed({ key: "t", error: "The log for lint / eslint didn't download: GitHub timed out after 30 s", retry, logUrl: "https://github.com/o/r/actions/runs/1/job/2" });
  const toast = getErrorToasts().at(-1)!;
  expect(toast).toMatchObject({ title: "Couldn't start Fix errors", action: "The log for lint / eslint didn't download: GitHub timed out after 30 s. Nothing was sent to the agent" });
  expect(toast.actions?.map((action) => [action.label, !!action.primary])).toEqual([["Try again", true], ["Open log on GitHub", false]]);
});

it("times a check to the second when it has finished, and to the minute while it runs", () => {
  const now = Date.parse("2026-11-16T10:10:00Z");
  expect(durationLabel(41_000)).toBe("41s");
  expect(durationLabel(192_000)).toBe("3m 12s");
  expect(durationLabel(120_000)).toBe("2m");
  expect(durationLabel(3_840_000)).toBe("1h 4m");
  const failed = { name: "test", state: "failure", startedAt: "2026-11-16T10:00:00Z", completedAt: "2026-11-16T10:03:12Z", summary: "2 tests failing" };
  expect(checkLine(failed, now)).toBe("Failed after 3m 12s · 2 tests failing");
  expect(checkLine({ name: "b", state: "in_progress", startedAt: "2026-11-16T10:06:00Z" }, now)).toBe("Running · 4m");
  expect(checkLine({ name: "b", state: "queued" }, now)).toBe("Queued");
  expect(checkLine({ name: "u", state: "success", startedAt: "2026-11-16T10:00:00Z", completedAt: "2026-11-16T10:02:48Z" }, now)).toBe("Passed in 2m 48s");
  expect(checkLine({ name: "d", state: "skipped", summary: "Skipped by a condition" }, now)).toBe("Skipped");
  expect(checkTime({ name: "b", state: "in_progress", startedAt: "2026-11-16T10:07:00Z" }, now)).toBe("running · 3m");
  expect(checkTime({ name: "l", state: "success", startedAt: "2026-11-16T10:00:00Z", completedAt: "2026-11-16T10:00:41Z" }, now)).toBe("41s");
});
