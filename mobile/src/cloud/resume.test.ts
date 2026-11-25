import { describe, expect, it } from "vitest";
import { CloudApiError } from "./api";
import { listedAsStarting, machineGone, mayBeUnderWay, resumeFailure, resumeLogDetail, resumeRetryable, ResumeUnconfirmed } from "./resume";
import { attentionDetail, connectionLine, openRefusalText } from "./words";

/** Nothing the phone says about a failed resume is a bare "That did not work." or a raw code (#1290). */
const plain = (text: string) => {
  expect(text).not.toMatch(/^That did not work/);
  expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
};

describe("what a failed resume request says (#1290)", () => {
  it("says a timeout, a network failure and an unreadable error answer apart, each with Try again", () => {
    const timeout = resumeFailure(new ResumeUnconfirmed(new CloudApiError("cloud_workspace_unavailable", null, "timeout"), true));
    expect(timeout).toMatchObject({ stage: "request", code: "timeout", retry: true });
    expect(timeout.text).toMatch(/did not answer in time, and the list does not show the workspace starting/);
    // The list was not read to check (that read failed, or nothing asked it): not said to be checked.
    for (const unchecked of [new ResumeUnconfirmed(new CloudApiError("cloud_workspace_unavailable", null, "timeout"), false), new CloudApiError("cloud_workspace_unavailable", null, "timeout")]) {
      expect(resumeFailure(unchecked).text).toBe("The service did not answer in time, and the list could not be read to check whether the workspace is starting. If it stays stopped, try again.");
    }
    const network = resumeFailure(new CloudApiError("cloud_workspace_unavailable", null, "network"));
    expect(network).toMatchObject({ stage: "request", code: "network", retry: true });
    expect(network.text).toMatch(/could not reach the service/);
    const unreadable = resumeFailure(new CloudApiError("cloud_workspace_unavailable", 502, "unreadable"));
    expect(unreadable).toMatchObject({ stage: "request", code: "http_502", status: 502, retry: true });
    expect(unreadable.text).toMatch(/service had a problem/);
    for (const failure of [timeout, network, unreadable]) plain(failure.text);
  });

  it("says an answer this app cannot read, with no Try again (asking again gets the same answer)", () => {
    const failure = resumeFailure(new CloudApiError("cloud_workspace_invalid_response", 200));
    expect(failure).toMatchObject({ stage: "answer", code: "cloud_workspace_invalid_response", retry: false });
    expect(failure.text).toMatch(/update the app/);
  });

  it("says a failure with no code (this phone's own) instead of 'That did not work.'", () => {
    const failure = resumeFailure(new Error("Something odd"));
    expect(failure).toMatchObject({ stage: "request", code: "client_error", retry: true });
    plain(failure.text);
  });

  it("says each known refusal with what to do next, and offers Try again only where it can help", () => {
    expect(resumeFailure(new CloudApiError("cloud_workspace_manager_required", 403))).toMatchObject({ retry: false, text: expect.stringMatching(/creator or an organization owner or admin can start it/) });
    expect(resumeFailure(new CloudApiError("cloud_workspace_archived", 409))).toMatchObject({ retry: false, text: expect.stringMatching(/Unarchive it on the desktop/) });
    expect(resumeFailure(new CloudApiError("cloud_workspace_member_concurrency_exceeded", 409))).toMatchObject({ retry: true, text: expect.stringMatching(/Stop one of yours/) });
    expect(resumeFailure(new CloudApiError("cloud_provider_credential_invalid", 409))).toMatchObject({ retry: true, text: expect.stringMatching(/Settings on the desktop/) });
    expect(resumeFailure(new CloudApiError("cloud_workspace_operation_in_progress", 409))).toMatchObject({ retry: true, text: expect.stringMatching(/still running/) });
    expect(resumeFailure(new CloudApiError("account_signed_out", 401))).toMatchObject({ retry: false, text: expect.stringMatching(/Sign in again/) });
  });

  it("says a code shared with other requests for a resume, and an unknown code without showing it", () => {
    const forbidden = resumeFailure(new CloudApiError("cloud_workspace_forbidden", 403));
    expect(forbidden).toMatchObject({ code: "cloud_workspace_forbidden", retry: false, text: "The workspace was not started: you do not have access to this workspace." });
    const unknown = resumeFailure(new CloudApiError("cloud_something_new", 409));
    expect(unknown).toMatchObject({ code: "cloud_something_new", retry: true });
    expect(unknown.text).toMatch(/open it on the desktop to see why/);
    plain(unknown.text);
  });

  it("asks the list whether a resume is under way only when no answer came, the service failed, or it says one runs", () => {
    expect(mayBeUnderWay(new CloudApiError("cloud_workspace_unavailable", null, "timeout"))).toBe(true);
    expect(mayBeUnderWay(new CloudApiError("cloud_workspace_unavailable", 503))).toBe(true);
    expect(mayBeUnderWay(new CloudApiError("cloud_workspace_operation_in_progress", 409))).toBe(true);
    expect(mayBeUnderWay(new CloudApiError("cloud_workspace_invalid_response", 200))).toBe(true);
    // Never sent: nothing can be under way.
    expect(mayBeUnderWay(new CloudApiError("cloud_workspace_unavailable", null, "network"))).toBe(false);
    expect(mayBeUnderWay(new CloudApiError("cloud_workspace_manager_required", 403))).toBe(false);
    expect(mayBeUnderWay(new Error("x"))).toBe(false);
  });

  it("reads 'starting' from the listed state or a resume operation that is queued or running", () => {
    const listed = (state: string, latestOperation: Record<string, unknown> | null = null) => ({ workspace: { state } as never, latestOperation: latestOperation as never });
    expect(listedAsStarting(listed("resuming"))).toBe(true);
    expect(listedAsStarting(listed("provisioning"))).toBe(true);
    expect(listedAsStarting(listed("ready"))).toBe(true);
    expect(listedAsStarting(listed("suspended", { id: "o", state: "running", action: "resume" }))).toBe(true);
    expect(listedAsStarting(listed("suspended", { id: "o", state: "failed", action: "resume" }))).toBe(false);
    expect(listedAsStarting(listed("suspended", { id: "o", state: "running", action: "suspend" }))).toBe(false);
    expect(listedAsStarting(null)).toBe(false);
  });

  it("writes the stage, code and status to the log line, and only the start of the workspace id", () => {
    expect(resumeLogDetail({ stage: "request", code: "cloud_workspace_manager_required", status: 403 }, "0123456789abcdef")).toBe("workspace 01234567 · stage request · code cloud_workspace_manager_required · HTTP 403");
    expect(resumeLogDetail({ stage: "operation", code: "none", status: null }, "ws-1")).toBe("workspace ws-1 · stage operation · code none");
  });
});

describe("a workspace that needs attention after a failed resume (#1290)", () => {
  it("offers Retry resume for any failed resume, as the desktop does, and not for another failed action", () => {
    for (const errorCode of ["cloud_provider_state_conflict", "cloud_provider_credential_invalid", "something_new", null]) {
      expect(resumeRetryable({ state: "failed", action: "resume", errorCode } as never)).toBe(true);
    }
    expect(resumeRetryable({ state: "failed", action: "suspend" })).toBe(false);
    expect(resumeRetryable({ state: "running", action: "resume" })).toBe(false);
    expect(resumeRetryable(null)).toBe(false);
  });

  // #1581: the provider no longer has the machine, so the same resume cannot work.
  it("does not offer Retry resume once the workspace's machine is gone", () => {
    expect(machineGone({ state: "failed", action: "resume", errorCode: "cloud_provider_not_found" })).toBe(true);
    expect(machineGone({ state: "failed", action: "resume", errorCode: "cloud_provider_not_found", detailCode: "box_lost_without_checkpoint" })).toBe(true);
    // A stop or archive of a missing machine: a resume may still restore it.
    for (const action of ["suspend", "archive"]) expect(machineGone({ state: "failed", action, errorCode: "cloud_provider_not_found", detailCode: "box_missing" })).toBe(false);
    expect(resumeRetryable({ state: "failed", action: "resume", errorCode: "cloud_provider_not_found" })).toBe(false);
    // Not the machine: a missing environment image, a delete (which finishes without it), a launch, or an operation still running.
    expect(machineGone({ state: "failed", action: "resume", errorCode: "cloud_provider_not_found", detailCode: "environment_image_missing" })).toBe(false);
    expect(resumeRetryable({ state: "failed", action: "resume", errorCode: "cloud_provider_not_found", detailCode: "environment_image_missing" })).toBe(true);
    expect(machineGone({ state: "failed", action: "delete", errorCode: "cloud_provider_not_found" })).toBe(false);
    expect(machineGone({ state: "failed", action: null, errorCode: "cloud_provider_not_found" })).toBe(false);
    expect(machineGone({ state: "running", action: "resume", errorCode: "cloud_provider_not_found" })).toBe(false);
    expect(machineGone({ state: "failed", action: "resume", errorCode: "cloud_provider_unavailable" })).toBe(false);
  });

  it("names what failed for the codes a resume fails with, and for a missing or unknown code", () => {
    expect(attentionDetail("cloud_provider_state_conflict")).toMatch(/does not allow resuming yet/);
    expect(attentionDetail("cloud_provider_connection_attention_required")).toMatch(/provider connection needs attention/);
    expect(attentionDetail("cloud_workspace_provisioning_timeout")).toMatch(/took too long to start/);
    expect(attentionDetail(null)).toBe("The last resume did not finish.");
    expect(attentionDetail("something_new")).toBe("The last resume did not finish.");
  });
});

describe("a refused connect after a resume (#1290)", () => {
  it("says why the service refused, never a bare 'Not connected.'", () => {
    expect(openRefusalText("cloud_workspace_forbidden")).toBe("You do not have access to this workspace.");
    expect(openRefusalText("cloud_something_new")).toBe("The service would not connect this phone to the workspace.");
    const stopped = { state: "stopped" } as const;
    expect(connectionLine(stopped, "ready", { kind: "api", code: "cloud_something_new", unreachable: false }).text).toBe("The service would not connect this phone to the workspace.");
    expect(connectionLine(stopped, "ready", null).text).toBe("Not connected to this workspace.");
  });
});
