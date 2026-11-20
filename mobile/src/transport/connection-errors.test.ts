import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canRetry, closeDetail, ConnectionAttemptError, connectionProblem, decisiveProblem, isTransportError, mayHaveArrived, pathProblem, problemText, screenMessage } from "./connection-errors";
import { CredentialRefusedError, RelayOuterError } from "./relay-client";

describe("an attempt that failed on every path (#1316)", () => {
  it("keeps a path's classification once its message is redacted and wrapped", () => {
    const wrapped = new ConnectionAttemptError("https://relay.example: relay_outer_4404 (the Mac is not connected to Relay)", "mac-offline");
    expect(connectionProblem(wrapped)).toBe("mac-offline");
    expect(connectionProblem(new ConnectionAttemptError("ws://192.168.1.2:6768: Direct handshake timed out", null))).toBeNull();
    // Still the connection's own, worded for the log and never for a screen.
    expect(screenMessage(wrapped, "fallback")).toBe("fallback");
  });

  it("counts a 4401 as the pairing refused only when it refuses this pairing", () => {
    expect(pathProblem(new CredentialRefusedError())).toBe("pairing-invalid");
    // A grace credential refused after a rotation, and a 4401 from an unverified direct peer.
    expect(pathProblem(new CredentialRefusedError(), false)).toBeNull();
    expect(pathProblem(new RelayOuterError(4401))).toBeNull();
    expect(pathProblem(new RelayOuterError(4404), false)).toBe("mac-offline");
    expect(pathProblem(new RelayOuterError(1006))).toBe("network");
    expect(pathProblem(new Error("WebSocket connection failed (network unavailable or connection refused)"))).toBe("network");
    expect(pathProblem(new Error("no answer 3 s after Relay failed"))).toBeNull();
  });

  it("reports the most telling cause, whatever order the paths failed in", () => {
    const mixed = [null, "network", "mac-offline", "dropped", "pairing-invalid"] as const;
    for (let shift = 0; shift < mixed.length; shift++) {
      expect(decisiveProblem([...mixed.slice(shift), ...mixed.slice(0, shift)])).toBe("pairing-invalid");
      expect(decisiveProblem([...mixed.slice(shift), ...mixed.slice(0, shift)].filter((problem) => problem !== "pairing-invalid"))).toBe("mac-offline");
    }
    expect(decisiveProblem([null, "network", "dropped"])).toBe("network");
    expect(decisiveProblem(["dropped", "too-large", "network"])).toBe("too-large");
    expect(decisiveProblem(["dropped", "no-answer", "reconnecting"])).toBe("no-answer");
    expect(decisiveProblem([null, null])).toBeNull();
    expect(decisiveProblem([])).toBeNull();
  });
});

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

  it("takes only an unanswered request to have most likely reached the Mac", () => {
    expect(mayHaveArrived("no-answer")).toBe(true);
    for (const problem of ["pairing-invalid", "mac-offline", "dropped", "reconnecting", "network", "too-large"] as const) expect(mayHaveArrived(problem)).toBe(false);
  });

  it("logs the code with what the close said", () => {
    expect(closeDetail(new RelayOuterError(1001, "Stream end encountered", false))).toBe('relay_outer_1001 (reason "Stream end encountered", not clean)');
    expect(closeDetail(new RelayOuterError(4408, "", true))).toBe("relay_outer_4408 (no reason, clean)");
    // A refused relay hello has no close event to describe.
    expect(closeDetail(new RelayOuterError(4404))).toBe("relay_outer_4404");
  });
});

describe("no transport message reaches a screen (#983)", () => {
  // Every message this side raises while making or keeping the connection, read from the source itself,
  // so a new one added there without being classified fails here.
  const thrown = (file: string) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    return [...source.matchAll(/new Error\((?:"([^"]+)"|`([^`]+)`)\)/g)].map((match) => (match[1] ?? match[2]!)
      // A template's parts are filled the way they are at run time.
      .replace(/\$\{redactEndpoint\([^}]*\)\}/g, "wss://relay.example.test")
      .replace(/\$\{DIRECT_GRACE_MS \/ 1_000\}/g, "3")
      .replace(/\$\{direct \? "Direct" : "Relay"\}/g, "Relay")
      .replace(/\$\{method\}/g, "session.send")
      .replace(/\$\{response\.status\}/g, "502")
      .replace(/\$\{relayError\(error\)\}|\$\{safeError\(error\)\}/g, "Relay connection closed")
      .replace(/\$\{errors\.join\("; "\)\}|\$\{reason\}/g, "wss://relay.example.test: Relay connection closed"));
  };
  // What is not the connection's: the Mac's refusal, said as it said it, and the pairing sheet's
  // own plain words for a pairing the person did not approve on the Mac in time.
  const theMacs = new Set(["${result.refusal.code}: ${result.refusal.message}", "The Mac did not answer the pairing request in time"]);
  const messages = [...thrown("./connection.ts"), ...thrown("./relay-client.ts")].filter((message) => !theMacs.has(message) && !message.includes("${"));

  it("finds the messages to check", () => {
    expect(messages).toContain("Host is disconnected");
    expect(messages).toContain("Relay connection closed");
    expect(messages.length).toBeGreaterThan(12);
  });

  it.each(messages)("%s", (message) => {
    const error = new Error(message);
    expect(isTransportError(error)).toBe(true);
    expect(screenMessage(error, "fallback")).toBe("fallback");
  });

  it("keeps the Mac's own message, and never an address", () => {
    expect(screenMessage(new Error("Open this conversation on your Mac."), "fallback")).toBe("Open this conversation on your Mac.");
    expect(screenMessage(new Error("Could not reach 192.0.2.4"), "fallback")).toBe("fallback");
    expect(screenMessage(new Error("ws://mac.local:6768 refused"), "fallback")).toBe("fallback");
    expect(screenMessage(new RelayOuterError(4408, "", false), "fallback")).toBe("fallback");
    expect(screenMessage("not an error", "fallback")).toBe("fallback");
  });
});
