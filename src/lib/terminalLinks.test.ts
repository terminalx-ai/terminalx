// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalLinkHandler, validateTerminalLink } from "./terminalLinks";

describe("S-23: xterm OSC 8 terminal link validation and handler", () => {
  it("allows clean https and http URLs without credentials", () => {
    expect(validateTerminalLink("https://example.com/docs?q=1#top")).toEqual({
      ok: true,
      url: "https://example.com/docs?q=1#top",
    });
    expect(validateTerminalLink("http://localhost:3000/status")).toEqual({
      ok: true,
      url: "http://localhost:3000/status",
    });
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "file:///Applications/Calculator.app",
    "terminalx://join/secret",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "mailto:user@example.com",
    "ssh://victim@host",
    "custom-scheme://launch",
    "https://user:pass@example.com/phish",
    "https://user@example.com/phish",
    "https://example.com/\nnewline",
  ])("rejects unsafe or credentialed URI %j", (uri) => {
    expect(validateTerminalLink(uri).ok).toBe(false);
  });

  it("never calls window.open, confirms the exact destination URL, and opens via validated openUrl only when confirmed", async () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const open = vi.fn().mockResolvedValue(undefined);
    const handler = createTerminalLinkHandler({ confirm, open });
    const dummyEvent = new MouseEvent("click");
    const dummyRange = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };

    // Blocked schemes never prompt or open.
    handler.activate(dummyEvent, "javascript:alert(1)", dummyRange);
    handler.activate(dummyEvent, "file:///etc/passwd", dummyRange);
    handler.activate(dummyEvent, "terminalx://join/abc", dummyRange);
    handler.activate(dummyEvent, "https://user:pass@evil.test/", dummyRange);
    await Promise.resolve();
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();

    // Valid URL cancelled by user does not open.
    handler.activate(dummyEvent, "https://example.test/path", dummyRange);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith("https://example.test/path");
    expect(open).not.toHaveBeenCalled();

    // Valid URL confirmed by user opens via validated opener, never window.open.
    handler.activate(dummyEvent, "https://example.test/confirmed", dummyRange);
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith("https://example.test/confirmed"));
    expect(windowOpen).not.toHaveBeenCalled();
    windowOpen.mockRestore();
  });
});
