import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorMessage, failureMessage } from "@/lib/cloudCreate";
import { onOpenOrganizationSettings, takeAgentLoginsRequest, takeOrganizationRequest } from "@/lib/settingsLinks";
import type { CloudWorkspaceSnapshot } from "@/lib/api";
import { AgentLoginsLink } from "./AgentLoginsLink";

afterEach(() => {
  cleanup();
  takeOrganizationRequest();
  takeAgentLoginsRequest("org-b");
});

describe("the way to Agent logins from a message that names them (#450)", () => {
  it("is offered next to a missing-login message, and asks the shell for Settings once", () => {
    const opened = vi.fn();
    const stop = onOpenOrganizationSettings(opened);
    render(<AgentLoginsLink message={createErrorMessage("cloud_workspace_agent_credential_required", "claude")} organizationId="org-b" />);
    expect(takeOrganizationRequest()).toBeUndefined();
    expect(takeAgentLoginsRequest("org-b")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open Agent logins" }));
    expect(opened).toHaveBeenCalledTimes(1);
    // The Organizations section takes the page it asks for, and the logins section the request to come into view, once each.
    expect(takeOrganizationRequest()).toBe("org-b");
    expect(takeOrganizationRequest()).toBeUndefined();
    expect(takeAgentLoginsRequest("org-b")).toBe(true);
    expect(takeAgentLoginsRequest("org-b")).toBe(false);
    stop();
  });

  it("is not offered for any other message", () => {
    render(<AgentLoginsLink message={createErrorMessage("cloud_workspace_quota_exceeded")} organizationId="org-b" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // PRO-107: every "sign in required" message opens the page of the organization it is about.
  it("opens the page of the workspace's own organization, never another organization's logins", () => {
    const failed = { workspace: { orgId: "org-b", launch: { category: "agent-sign-in-required" } }, operation: null } as unknown as CloudWorkspaceSnapshot;
    render(<AgentLoginsLink message={failureMessage(failed)} organizationId={failed.workspace.orgId} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Agent logins" }));
    expect(takeOrganizationRequest()).toBe("org-b");
    // Another organization's logins section does not take the request meant for org-b.
    expect(takeAgentLoginsRequest("org-a")).toBe(false);
    expect(takeAgentLoginsRequest("org-b")).toBe(true);
  });

  it("opens the active organization's page when the message names no organization", () => {
    render(<AgentLoginsLink message={createErrorMessage("cloud_workspace_agent_credential_required", "codex", true)} organizationId={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Agent logins" }));
    expect(takeOrganizationRequest()).toBeNull();
    expect(takeAgentLoginsRequest("org-a")).toBe(true);
  });
});
