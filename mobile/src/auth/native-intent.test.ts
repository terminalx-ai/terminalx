import { describe, expect, it } from "vitest";
import { systemPathFor } from "./native-intent";

describe("a link that opens the app", () => {
  it("keeps the app where it is for the sign-in callback, which Android hands back as a link", () => {
    expect(systemPathFor("terminalx://auth/callback?code=abc&state=xyz")).toBeNull();
    expect(systemPathFor("terminalx://auth/callback/")).toBeNull();
  });

  it("opens every other link as before", () => {
    expect(systemPathFor("terminalx://pair?code=123")).toBe("terminalx://pair?code=123");
    expect(systemPathFor("/session/abc")).toBe("/session/abc");
  });
});
