import { describe, expect, it } from "vitest";
import { canRetry, closeDetail, connectionProblem, problemText } from "./connection-errors";
import { RelayOuterError } from "./relay-client";

describe("transport failures in plain words (#670)", () => {
  it.each([
    [4401, "pairing-invalid", "this phone is no longer paired with your Mac; pair it again from Machines"],
    [4404, "mac-offline", "your Mac is offline"],
    [4408, "dropped", "the connection to your Mac dropped"],
    [1001, "dropped", "the connection to your Mac dropped"],
    [4409, "reconnecting", "the phone is reconnecting to your Mac"],
    [1006, "network", "a network problem interrupted the connection to your Mac"],
    [4413, "too-large", "a message too large for Relay dropped the connection to your Mac"],
    [4999, "dropped", "the connection to your Mac dropped"],
  ] as const)("reads close %i as %s", (code, problem, text) => {
    expect(connectionProblem(new RelayOuterError(code, "", false))).toBe(problem);
    expect(problemText(problem)).toBe(text);
    expect(problemText(problem)).not.toMatch(/\d/);
  });

  it("reads this side's own transport errors, and leaves the Mac's answers alone", () => {
    expect(connectionProblem(new Error("Host is disconnected"))).toBe("dropped");
    expect(connectionProblem(new Error("Relay connection unavailable"))).toBe("dropped");
    expect(connectionProblem(new Error("Relay connection closed"))).toBe("dropped");
    expect(connectionProblem(new Error("WebSocket connection failed (network unavailable or connection refused)"))).toBe("network");
    expect(connectionProblem(new Error("RPC timed out: session.send"))).toBe("no-answer");
    expect(connectionProblem(new Error("The agent is busy"))).toBeNull();
    expect(connectionProblem("relay_outer_1001")).toBeNull();
  });

  it("offers a retry unless the pairing itself was refused", () => {
    expect(canRetry("pairing-invalid")).toBe(false);
    for (const problem of ["mac-offline", "dropped", "reconnecting", "network", "too-large", "no-answer"] as const) expect(canRetry(problem)).toBe(true);
  });

  it("logs the code with what the close said", () => {
    expect(closeDetail(new RelayOuterError(1001, "Stream end encountered", false))).toBe('relay_outer_1001 (reason "Stream end encountered", not clean)');
    expect(closeDetail(new RelayOuterError(4408, "", true))).toBe("relay_outer_4408 (no reason, clean)");
    // A refused relay hello has no close event to describe.
    expect(closeDetail(new RelayOuterError(4404))).toBe("relay_outer_4404");
  });
});
