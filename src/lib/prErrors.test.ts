import { describe, expect, it } from "vitest";
import { prErrorKind } from "./prErrors";

describe("prErrorKind", () => {
  it("judges gh's own text", () => {
    expect(prErrorKind("gh pr view: call did not answer within 120s")).toBe("timeout");
    expect(prErrorKind("dial tcp: lookup api.github.com: no such host")).toBe("offline");
    expect(prErrorKind("connect: connection refused")).toBe("offline");
    expect(prErrorKind("HTTP 403: Resource not accessible by integration")).toBe("access");
    expect(prErrorKind("Resource protected by organization SAML enforcement.")).toBe("access");
    expect(prErrorKind("gh: authentication required")).toBe("access");
    expect(prErrorKind("HTTP 502: Bad Gateway")).toBeNull();
  });
  it("does not call every message that mentions authentication an access problem", () => {
    expect(prErrorKind("git fetch: SSH authentication agent not running")).toBeNull();
    expect(prErrorKind("Two-factor authentication settings changed")).toBeNull();
  });
  it("has no tag of its own to strip: errors other screens show stay as gh wrote them", () => {
    expect(prErrorKind("[pr-error:offline] anything")).toBeNull();
  });
});
