import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, type OrganizationPlanPrice } from "@/lib/api";
import { consoleUrl } from "@/lib/consoleUrl";
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

function formatPrice(price: OrganizationPlanPrice) {
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency: price.currency, maximumFractionDigits: 2,
  }).format(price.unitAmountMinor / 100);
}

export function PlansView() {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const [consoleError, setConsoleError] = useState<string | null>(null);
  const org = status.organizations?.find((candidate) => candidate.id === status.identity?.organizationId);
  const plan = status.state === "signed-in" && privacy.ready && !privacy.enabled ? org?.plan : undefined;
  const teams = plan?.catalog.teams;
  const pro = plan?.catalog.pro;
  const upgrade = consoleUrl(plan?.links?.upgrade);
  const manage = consoleUrl(plan?.links?.manage);
  const canManage = org?.role === "owner";

  const openConsole = async (url: string) => {
    setConsoleError(null);
    try {
      await openUrl(url);
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
        {plan && teams && org ? (
          <>
          <p className="mb-4 text-sm text-muted-foreground">Pro is billed to you. Teams is billed to your organization.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {TIERS.map((tier) => (
              <section key={tier.id} className="rounded-lg border border-hairline p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-medium">{tier.name}</h2>
                  {plan.plan === tier.id && <span className="rounded bg-veil-raised px-1.5 py-0.5 text-xs">Your plan</span>}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{tier.id === "teams" ? `One bill for ${org.name}` : tier.description}</p>
                {tier.id === "free" && <p className="mt-2 text-sm">$0</p>}
                {tier.id === "pro" && pro && <p className="mt-2 text-sm">{formatPrice(pro)} / {pro.interval}</p>}
                {tier.id === "teams" && (
                  <div className="mt-2 space-y-1 text-sm">
                    <p>{formatPrice(teams)} per seat / {teams.interval}</p>
                    <p className="text-muted-foreground">Up to {teams.memberLimit} members</p>
                  </div>
                )}
                <ul className="mt-3 list-disc space-y-1 pl-4 text-xs">
                  {tier.features.map((feature) => <li key={feature}>{feature}</li>)}
                </ul>
                {tier.id === "pro" && upgrade && (
                  <Button className="mt-3" size="sm" onClick={() => void openConsole(upgrade)}>Upgrade to Pro</Button>
                )}
                {tier.id === "teams" && canManage && manage && (
                  <Button className="mt-3" size="sm" variant="secondary" onClick={() => void openConsole(manage)}>Manage in console</Button>
                )}
                {tier.id === "teams" && !canManage && <p className="mt-3 text-xs text-muted-foreground">Ask an owner to switch.</p>}
              </section>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Cloud compute is billed by your provider.</p>
          <p className="mt-1 text-xs text-muted-foreground">Checkout, invoices and seat changes open in the web console.</p>
          {consoleError && <p className="mt-2 text-xs text-destructive" role="alert">{consoleError}</p>}
          </>
        ) : <p className="text-sm text-muted-foreground">Plans are unavailable for this organization.</p>}
      </div>
    </section>
  );
}
