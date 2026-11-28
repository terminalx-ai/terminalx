import { beforeEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl }));

const { openExternalWebUrl, validateExternalWebUrl } = await import("./externalUrl");

beforeEach(() => {
  opener.openUrl.mockClear();
});

describe("externalUrl (S-43)", () => {
  it("accepts valid https URLs and rejects http unless allowHttp is set", () => {
    expect(validateExternalWebUrl("https://github.com/terminalx-ai/terminalx/pull/1")).toBe("https://github.com/terminalx-ai/terminalx/pull/1");
    expect(validateExternalWebUrl("http://localhost:3000/preview")).toBeNull();
    expect(validateExternalWebUrl("http://localhost:3000/preview", { allowHttp: true })).toBe("http://localhost:3000/preview");
  });

  it("rejects non-web schemes, credentialed URLs, and control characters", () => {
    for (const bad of [
      "",
      "   ",
      "mailto:security@example.com",
      "tel:+15551234567",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "x-apple.systempreferences:com.apple.preference.security",
      "https://user:pass@github.com/org/repo",
      "https://user@github.com/org/repo",
      "https://github.com/org/repo\nX-Injected: 1",
      "not-a-url",
    ]) {
      expect(validateExternalWebUrl(bad)).toBeNull();
      expect(validateExternalWebUrl(bad, { allowHttp: true })).toBeNull();
    }
  });

  it("opens validated URLs via Tauri opener and refuses unsafe schemes", async () => {
    await openExternalWebUrl("https://linear.app/team/ENG-42");
    expect(opener.openUrl).toHaveBeenCalledExactlyOnceWith("https://linear.app/team/ENG-42");

    opener.openUrl.mockClear();
    await expect(openExternalWebUrl("x-apple.systempreferences:com.apple.preference.security")).rejects.toThrow(/Refused/);
    await expect(openExternalWebUrl("mailto:victim@example.com")).rejects.toThrow(/Refused/);
    await expect(openExternalWebUrl("https://user:secret@example.com/path")).rejects.toThrow(/Refused/);
    expect(opener.openUrl).not.toHaveBeenCalled();
  });
});
