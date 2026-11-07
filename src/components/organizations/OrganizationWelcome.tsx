import { useState } from "react";
import { X } from "@/icons";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import type { OrganizationSummary } from "@/lib/api";
import { dismissWelcome, useWelcomeDismissed, useWelcomeReadiness, welcomeAgents, type Readiness } from "@/lib/organizationWelcome";
import { openOwnModelRoutes, openWelcomeOrganizationSettings } from "@/lib/settingsLinks";

const labels: Record<Readiness, string> = { loading: "Checking…", ready: "Ready", "not-ready": "Not ready", unknown: "Unknown", unavailable: "Unavailable — try refreshing" };

export function OrganizationWelcome({ organization }: { organization: OrganizationSummary }) {
  const { status } = useAccount();
  const account = status.state === "signed-in" ? status.context?.account : null;
  const dismissed = useWelcomeDismissed(account ?? "", organization.id);
  if (!account || dismissed || !status.organizations?.some((org) => org.id === organization.id)) return null;
  return <WelcomeCard key={JSON.stringify([account, organization.id])} account={account} organization={organization} />;
}
function WelcomeCard({ account, organization }: { account: string; organization: OrganizationSummary }) {
  const { data, retry } = useWelcomeReadiness(organization.id);
  const [error, setError] = useState(false);
  const name = organization.name;
  return (
    <section aria-label={`Welcome to ${name}`} data-testid="organization-welcome" className="my-2 min-w-0 rounded-lg border border-hairline bg-well p-3 text-xs">
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 break-words font-semibold">Welcome to {name}</h3>
        <Button size="icon-xs" variant="ghost" aria-label={`Dismiss welcome to ${name}`} onClick={() => setError(!dismissWelcome(account, organization.id))}><X aria-hidden /></Button>
      </div>
      <p className="mt-2 text-muted-foreground">Organization repositories and agent logins are managed by your admins. You do not need to connect personal GitHub or agent accounts when organization access is ready.</p>
      <dl className="mt-3 space-y-2" aria-live="polite">
        <ReadinessLine name="Repositories" state={data.repositories.state} detail={data.repositories.count ? `${data.repositories.count} accessible` : undefined} />
        {welcomeAgents.map((agent) => <ReadinessLine key={agent.id} name={agent.name} state={data.agents[agent.id]} />)}
        {data.compute === "selection-required" ? <div>
          <dt className="font-medium">Compute</dt>
          <dd className="break-words text-muted-foreground">Choose {name} as your default organization in Settings to check compute.</dd>
        </div> : <ReadinessLine name="Compute" state={data.compute} />}
        <div><dt className="font-medium">Admins</dt><dd className="break-words text-muted-foreground">{data.admins.state === "ready" ? data.admins.names.join(", ") : labels[data.admins.state]}</dd></div>
      </dl>
      <p className="mt-2 text-muted-foreground">Agent readiness reflects preflight for your own private workspace. Compute availability does not guarantee capacity or permission to create a workspace.</p>
      <div className="mt-3 flex flex-col items-start gap-2">
        {data.compute === "selection-required" && <Button size="xs" variant="outline" className="h-auto min-h-6 whitespace-normal text-left" onClick={() => openWelcomeOrganizationSettings(organization.id, account)}>Open organization settings</Button>}
        <Button size="xs" variant="outline" className="h-auto min-h-6 whitespace-normal text-left" onClick={() => openOwnModelRoutes(organization.id, account)}>Use my own model route</Button>
        <span className="text-muted-foreground">Optional — organization access remains the default.</span>
        <Button size="xs" variant="ghost" onClick={retry}>Refresh readiness</Button>
      </div>
      {error && <p role="alert" className="mt-2 text-destructive">The dismissal could not be saved. Try again.</p>}
    </section>
  );
}
function ReadinessLine({ name, state, detail }: { name: string; state: Readiness; detail?: string }) {
  return <div><dt className="font-medium">{name}</dt><dd className="break-words text-muted-foreground">{labels[state]}{detail ? ` · ${detail}` : ""}</dd></div>;
}
