import { describe, expect, it } from "vitest";
import { prErrorDetails, prErrorKind } from "./prErrors";

describe("prErrorKind", () => {
  it("reads Rust's tag first", () => {
    expect(prErrorKind("[pr-error:offline] anything")).toBe("offline");
    expect(prErrorDetails("[pr-error:timeout] gh pr view")).toBe("gh pr view");
  });
  it("judges untagged text", () => {
    expect(prErrorKind("gh pr view: call did not answer within 120s")).toBe("timeout");
    expect(prErrorKind("dial tcp: lookup api.github.com: no such host")).toBe("offline");
    expect(prErrorKind("HTTP 403: Resource not accessible by integration")).toBe("access");
    expect(prErrorKind("HTTP 502: Bad Gateway")).toBeNull();
  });
});
