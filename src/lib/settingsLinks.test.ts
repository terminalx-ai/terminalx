import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetAgentLoginsRequest, onOpenOrganizationSettings, openAgentLogins, openOrganizationSettings, takeAgentLoginsRequest, takeAgentLoginsSignIn, takeOrganizationRequest } from "./settingsLinks";

afterEach(() => { takeOrganizationRequest(); forgetAgentLoginsRequest(); });

describe("settings row links", () => {
  it("maps organization and agent-login entry points to stable rows while preserving sign-in consent", () => {
    const listener = vi.fn();
    const stop = onOpenOrganizationSettings(listener);
    try {
      openOrganizationSettings("org-a");
      expect(listener).toHaveBeenLastCalledWith("organizations.overview");
      expect(takeOrganizationRequest()).toBe("org-a");
      openAgentLogins("org-b", "codex");
      expect(listener).toHaveBeenLastCalledWith("organizations.agentLogins");
      expect(takeOrganizationRequest()).toBe("org-b");
      expect(takeAgentLoginsRequest("org-a")).toBe(false);
      expect(takeAgentLoginsRequest("org-b")).toBe(true);
      expect(takeAgentLoginsSignIn("org-b")).toBe("codex");
      expect(takeAgentLoginsSignIn("org-b")).toBeNull();
    } finally { stop(); }
    const before = listener.mock.calls.length;
    openOrganizationSettings(null);
    expect(listener).toHaveBeenCalledTimes(before);
  });
});
