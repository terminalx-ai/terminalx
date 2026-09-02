import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { chooseMode, closeBypass, useDialogs } from "@/lib/dialogs";
import { bypassEffect } from "@/lib/models";
import { setPrefs } from "@/lib/prefs";

describe("choosing a permission mode", () => {
  beforeEach(() => {
    setPrefs({ bypassConfirmed: false });
    closeBypass();
  });

  it("applies every mode that leaves something asking", () => {
    const { result } = renderHook(() => useDialogs());
    for (const mode of ["plan", "manual", "auto", "acceptEdits"]) {
      const seen: string[] = [];
      act(() => chooseMode("claude", mode, (m) => seen.push(m)));
      expect(seen).toEqual([mode]);
      expect(result.current.bypass, `${mode} asks nothing`).toBeNull();
    }
  });

  it("holds the bypass until it has been agreed to", () => {
    const { result } = renderHook(() => useDialogs());
    const seen: string[] = [];

    act(() => chooseMode("codex", "bypassPermissions", (m) => seen.push(m)));
    expect(seen, "nothing takes effect while the dialog is up").toEqual([]);
    expect(result.current.bypass?.harness).toBe("codex");

    // Cancelled: the tab stays on whatever mode it had.
    act(() => closeBypass());
    expect(seen).toEqual([]);
    expect(result.current.bypass).toBeNull();

    // Agreed: exactly the mode that was asked about is the one applied.
    act(() => chooseMode("codex", "bypassPermissions", (m) => seen.push(m)));
    act(() => result.current.bypass?.confirm());
    expect(seen).toEqual(["bypassPermissions"]);
  });

  it("stops asking once the reader has said not to", () => {
    const { result } = renderHook(() => useDialogs());
    act(() => setPrefs({ bypassConfirmed: true }));
    const seen: string[] = [];
    act(() => chooseMode("claude", "bypassPermissions", (m) => seen.push(m)));
    expect(seen).toEqual(["bypassPermissions"]);
    expect(result.current.bypass).toBeNull();
  });
});

describe("what bypassing means", () => {
  it("names the flag each agent is actually launched with", () => {
    expect(bypassEffect("claude").flag).toBe("--permission-mode bypassPermissions");
    // Codex's flag drops the sandbox as well as the approvals, and what the
    // reader agrees to has to say both.
    expect(bypassEffect("codex").flag).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(bypassEffect("codex").effect).toMatch(/sandbox/);
    expect(bypassEffect("codex").effect).toMatch(/approvals/);
    // An agent with no flag of its own still gets a real warning.
    expect(bypassEffect("opencode").effect.length).toBeGreaterThan(20);
  });
});
