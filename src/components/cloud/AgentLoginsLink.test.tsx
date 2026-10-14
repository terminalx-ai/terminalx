import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorMessage } from "@/lib/cloudCreate";
import { onOpenAgentLogins, takeAgentLoginsRequest } from "@/lib/settingsLinks";
import { AgentLoginsLink } from "./AgentLoginsLink";

afterEach(cleanup);

describe("the way to Agent logins from a message that names them (#450)", () => {
  it("is offered next to a missing-login message, and asks the shell for Settings once", () => {
    const opened = vi.fn();
    const stop = onOpenAgentLogins(opened);
    render(<AgentLoginsLink message={createErrorMessage("cloud_workspace_agent_credential_required", "claude")} />);
    expect(takeAgentLoginsRequest()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open Agent logins" }));
    expect(opened).toHaveBeenCalledTimes(1);
    // The section takes the request when it mounts, once.
    expect(takeAgentLoginsRequest()).toBe(true);
    expect(takeAgentLoginsRequest()).toBe(false);
    stop();
  });

  it("is not offered for any other message", () => {
    render(<AgentLoginsLink message={createErrorMessage("cloud_workspace_quota_exceeded")} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
