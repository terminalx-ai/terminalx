import { describe, expect, it } from "vitest";
import { MAC_NEEDS_UPDATE, plainRefusal } from "./refusal";

describe("a refusal as the phone shows it (#730)", () => {
  it("says the Mac needs updating or restarting for an operation its runtime does not know", () => {
    // As a 0.2.22 app passed on its 0.2.21 runtime's refusal, and as the runtime says it.
    expect(plainRefusal({ code: "unavailable", message: "internal: Unsupported paired-device owner operation." })).toEqual({ code: "unavailable", message: MAC_NEEDS_UPDATE });
    expect(plainRefusal({ code: "unavailable", message: "Unsupported paired-device owner operation." }).message).toBe(MAC_NEEDS_UPDATE);
    expect(MAC_NEEDS_UPDATE).toBe("TerminalX on your Mac needs updating or restarting to do this.");
  });

  it("leaves every other refusal as the Mac said it", () => {
    const refusal = { code: "forbidden", message: "Method 'terminal.open' is not available to this paired device", data: { method: "terminal.open" } };
    expect(plainRefusal(refusal)).toBe(refusal);
    expect(plainRefusal({ code: "unavailable", message: "The tab is not running." }).message).toBe("The tab is not running.");
  });
});
