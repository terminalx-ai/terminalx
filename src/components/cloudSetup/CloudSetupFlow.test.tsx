import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, AgentLogin } from "@/lib/api";
import { leaveCloudSetup } from "@/lib/cloudSetupFlow";
import { loadSetups, newSetup, saveSetup, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { CloudSetupFlow } from "./CloudSetupFlow";

const mocks = vi.hoisted(() => ({ status: null as unknown as AccountStatus, held: { leave: null as (() => void) | null } }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: mocks.status, ready: true, busy: false }), refreshAccount: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/components/settings/OrganizationAgentLogins", () => ({
  agentLoginUsable: (login: AgentLogin | undefined) => login?.state === "connected",
  OrganizationAgentLogins: ({ onLogins }: { onLogins?: (logins: AgentLogin[]) => void }) => {
    useEffect(() => onLogins?.([{ provider: "claude", state: "connected" } as AgentLogin]), [onLogins]);
    return <div>Agent logins</div>;
  },
}));
vi.mock("./GithubStep", () => ({ GithubStep: () => <div>GitHub step</div> }));
vi.mock("./ComputeStep", () => ({ ComputeStep: () => <div>Compute step</div> }));
vi.mock("./InviteStep", () => ({ InviteStep: () => <div>Invite step</div> }));
vi.mock("./EnvironmentStep", async () => {
  const { useLeaveGuard } = await import("./FlowLayout");
  return {
    EnvironmentStep: () => {
      // Unbuilt changes: every way out waits for the person's answer.
      useLeaveGuard((leave) => {
        mocks.held.leave = leave;
        return false;
      });
      return <div>Environment step</div>;
    },
  };
});

const EMAIL = "ada@example.com";
const at = (step: string): OrganizationSetupRecord => ({ ...newSetup("Team", "request-1"), organizationId: "org-1", step: "compute", flow: { step, passed: ["organization", "github", "compute"], finishedAt: null } });

beforeEach(() => {
  localStorage.clear();
  mocks.held.leave = null;
  mocks.status = {
    state: "signed-in",
    identity: { name: "Ada", email: EMAIL, organization: "Team", organizationId: "org-1" },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "r1" },
    organizations: [{ id: "org-1", name: "Team", role: "owner" }],
  } as AccountStatus;
});
afterEach(cleanup);

const mount = (onExit = vi.fn()) => render(<CloudSetupFlow target={{ kind: "resume", organizationId: "org-1" }} onExit={onExit} onDone={vi.fn()} />);

describe("the full-window cloud setup", () => {
  it("resumes at the step it was left at and marks it current", () => {
    saveSetup(EMAIL, at("logins"));
    mount();
    expect(screen.getByTestId("cloud-setup-flow").dataset.step).toBe("logins");
    expect(screen.getByRole("button", { name: /Agent logins/, current: "step" })).toBeTruthy();
    expect(screen.getAllByLabelText("done")).toHaveLength(3);
  });

  it("keeps what a step stored when it goes on in the same moment", async () => {
    saveSetup(EMAIL, at("logins"));
    mount();
    const go = await screen.findByRole("button", { name: /^Continue/ });
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByTestId("cloud-setup-flow").dataset.step).toBe("environment"));
    const [stored] = loadSetups(EMAIL);
    expect(stored).toMatchObject({ logins: "connected", flow: { step: "environment", passed: ["organization", "github", "compute", "logins"] } });
  });

  it("asks before leaving the Environment step, from the flow or from elsewhere in the app", () => {
    saveSetup(EMAIL, at("environment"));
    const onExit = vi.fn();
    mount(onExit);
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    expect(onExit).not.toHaveBeenCalled();
    act(() => mocks.held.leave!());
    expect(onExit).toHaveBeenCalledOnce();

    const navigate = vi.fn();
    act(() => leaveCloudSetup(navigate));
    expect(navigate).not.toHaveBeenCalled();
    act(() => mocks.held.leave!());
    expect(navigate).toHaveBeenCalledOnce();
  });
});
