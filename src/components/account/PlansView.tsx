import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { openWelcome } from "@/lib/sessions";
import { Button } from "@/components/ui/button";

const TIERS = [
  {
    id: "free", name: "Free", description: "Local work on this Mac",
    features: ["Local sessions with Claude Code and Codex", "Worktrees, diffs, checks, and pull requests", "Phone pairing over the encrypted relay", "Local VM and the TerminalX command line"],
  },
  {
    id: "pro", name: "Pro", description: "Cloud and organizations of your own",
    features: ["Everything in Free", "Create organizations and invite teammates", "Cloud workspaces on your own compute", "Cloud automations and desktop"],
  },
  {
    id: "teams", name: "Teams", description: "One bill for your organization",
    features: ["A plan shared by the organization", "Seats follow accepted invites", "Owners can view seat usage and billing in the console"],
  },
] as const;

export function PlansView() {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const org = status.organizations?.find((candidate) => candidate.id === status.identity?.organizationId);
  const plan = status.state === "signed-in" && privacy.ready && !privacy.enabled ? org?.plan : undefined;
  const teams = plan?.catalog.teams;
  const teamsPrice = teams
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: teams.currency, maximumFractionDigits: 2 }).format(teams.unitAmountMinor / 100)
    : null;

  const canManage = org?.role === "owner" || org?.role === "admin";
  const openConsole = async () => {
    if (!plan || !org || !canManage) return;
    setConsoleError(null);
    try {
      await api.organizationConsoleOpen(org.id);
    } catch (error) {
      setConsoleError(errorMessage(error));
    }
  };

  return (
    <section className="min-h-0 flex-1 overflow-auto p-6" aria-labelledby="desktop-plans-title">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h1 id="desktop-plans-title" className="text-xl font-semibold">Plans</h1>
          <Button size="sm" variant="ghost" onClick={() => openWelcome()}>Done</Button>
        </header>
        {plan && teams && teamsPrice ? (
          <>
          <p className="mb-4 text-sm text-muted-foreground">Pro is billed to you. Teams is billed to your organization.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {TIERS.map((tier) => (
              <section key={tier.id} className="rounded-lg border border-hairline p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-medium">{tier.name}</h2>
                  {plan.plan === tier.id && <span className="rounded bg-veil-raised px-1.5 py-0.5 text-xs">Current plan</span>}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{tier.description}</p>
                {tier.id === "teams" && (
                  <div className="mt-2 space-y-1 text-sm">
                    <p>{teamsPrice} per seat / {teams.interval}</p>
                    <p className="text-muted-foreground">Up to {teams.memberLimit} members</p>
                  </div>
                )}
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs">
                  {tier.features.map((feature) => <li key={feature}>{feature}</li>)}
                </ul>
                {tier.id === "teams" && (canManage
                  ? <Button className="mt-3" size="sm" variant="secondary" onClick={() => void openConsole()}>Manage in console</Button>
                  : <p className="mt-3 text-xs text-muted-foreground">Ask an owner to switch.</p>)}
              </section>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Cloud compute is billed by your provider.</p>
          {consoleError && <p className="mt-2 text-xs text-destructive" role="alert">{consoleError}</p>}
          </>
        ) : <p className="text-sm text-muted-foreground">Plans are unavailable for this organization.</p>}
      </div>
    </section>
  );
}
