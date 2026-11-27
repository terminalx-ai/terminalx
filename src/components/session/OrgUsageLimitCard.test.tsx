import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({ api: { cloudAgentLogins: vi.fn() } }));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => undefined) }));
import { copyText } from "@/lib/clipboard";
import { OrgUsageLimitCard, switchTarget, usageLimitCardText } from "./OrgUsageLimitCard";

const at18 = new Date(2026, 10, 27, 18, 0).getTime();
const clock = new Date(at18).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cloudAgentLogins).mockRejectedValue({ code: "organization_admin_required" });
});
afterEach(cleanup);

describe("usage-limit card (PRO-200, design 17.13)", () => {
  it("tells a member an admin has to act, and copies a ready request", async () => {
    const onSwitch = vi.fn();
    render(<OrgUsageLimitCard harness="codex" organizationId="org-1" organization="Acme Robotics" resetsAt={at18} busy={false} onSwitch={onSwitch} />);
    const card = screen.getByTestId("org-usage-limit");
    expect(card.textContent).toContain("Codex usage limit reached");
    expect(card.textContent).toContain(`The Codex login Acme Robotics set for cloud workspaces is out of usage until ${clock}. Ask an organization admin to raise it or switch logins.`);
    fireEvent.click(screen.getByTestId("usage-limit-copy"));
    expect(copyText).toHaveBeenCalledWith(`Codex in Acme Robotics’s cloud workspaces has reached its usage limit until ${clock}. Could you raise the limit or switch the Codex login in Settings → Organizations → Acme Robotics → Agent logins?`);
    await waitFor(() => expect(screen.getByTestId("usage-limit-copy").textContent).toBe("Copied"));
    expect(screen.getByTestId("usage-limit-switch").textContent).toBe("Switch to Claude Code");
    expect(card.textContent).toContain("Switch opens a Claude Code tab that continues from this conversation.");
    fireEvent.click(screen.getByTestId("usage-limit-switch"));
    expect(onSwitch).toHaveBeenCalledWith("claude");
  });

  it("names whose login ran out when the reader may list the organization's logins", async () => {
    vi.mocked(api.cloudAgentLogins).mockResolvedValue({ credentials: [
      { provider: "codex", authKind: "oauth-credentials-json", fingerprint: "f", version: 1, updatedAt: 1, displayIdentity: "Ada Example" },
    ] });
    render(<OrgUsageLimitCard harness="codex" organizationId="org-1" organization="Acme Robotics" resetsAt={null} busy={false} />);
    await waitFor(() => expect(screen.getByTestId("org-usage-limit").textContent).toContain("Ada Example’s login is out of Codex usage. It is the Codex login Acme Robotics set for cloud workspaces."));
    expect(api.cloudAgentLogins).toHaveBeenCalledWith("org-1");
    // No switch where the tab can't open another.
    expect(screen.queryByTestId("usage-limit-switch")).toBeNull();
  });

  it("switches Claude Code to Codex and anything else to Claude Code", () => {
    expect(switchTarget("claude")).toBe("codex");
    expect(switchTarget("codex")).toBe("claude");
    expect(switchTarget("cursor")).toBe("claude");
    expect(usageLimitCardText({ agent: "Cursor", organization: "Acme", resetsAt: null, who: null }).title).toBe("Cursor usage limit reached");
  });
});
