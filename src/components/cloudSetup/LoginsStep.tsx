import { useState } from "react";
import type { AgentLogin } from "@/lib/api";
import { agentLoginUsable, OrganizationAgentLogins } from "@/components/settings/OrganizationAgentLogins";
import { PrimaryButton, StepActions, StepPage } from "./FlowLayout";
import type { StepProps } from "./stepProps";

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

/**
 * Step 4 (12.04): what the agents in the organization's cloud workspaces sign
 * in with, as the organization's page has it (PRO-107): each agent's login
 * opens its own sign-in dialog. Logins can wait: going on without one is
 * recorded, and the organization's page says which are missing.
 */
export function LoginsStep({ organization, record, onRecord, contextRevision, onContinue }: StepProps) {
  const [logins, setLogins] = useState<AgentLogin[] | null>(null);
  const usable = (logins ?? []).filter((login) => agentLoginUsable(login)).map((login) => NAMES[login.provider] ?? login.provider);
  const go = () => {
    onRecord({ ...record, logins: usable.length ? "connected" : "later" });
    onContinue();
  };
  return (
    <StepPage title="Agent logins" description="Cloud workspaces run agents on logins the organization stores. Members use them; they don't sign in themselves.">
      <div data-testid="cloud-setup-logins">
        <OrganizationAgentLogins contextRevision={contextRevision} organizationId={organization.id} organizationName={organization.name} reveal={false} onLogins={setLogins} />
      </div>
      <StepActions
        note={
          logins === null
            ? undefined
            : usable.length
              ? `${usable.join(" and ")} ${usable.length === 1 ? "is" : "are"} ready for ${organization.name}'s workspaces`
              : "No login yet. You can add them later on the organization's page"
        }
      >
        <PrimaryButton onClick={go}>{usable.length ? "Continue" : "Set up later"}</PrimaryButton>
      </StepActions>
    </StepPage>
  );
}
