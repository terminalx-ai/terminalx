import { useAccount } from "@/lib/account";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { openWelcome } from "@/lib/sessions";
import { Button } from "@/components/ui/button";

const TIERS = [
  { id: "free", name: "Free" },
  { id: "pro", name: "Pro" },
  { id: "teams", name: "Teams" },
] as const;

export function PlansView() {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const org = status.organizations?.find((candidate) => candidate.id === status.identity?.organizationId);
  const plan = status.state === "signed-in" && privacy.ready && !privacy.enabled ? org?.plan : undefined;
  const teams = plan?.catalog.teams;
  const teamsPrice = teams
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: teams.currency, maximumFractionDigits: 2 }).format(teams.unitAmountMinor / 100)
    : null;

  return (
    <section className="min-h-0 flex-1 overflow-auto p-6" aria-labelledby="desktop-plans-title">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h1 id="desktop-plans-title" className="text-xl font-semibold">Plans</h1>
          <Button size="sm" variant="ghost" onClick={() => openWelcome()}>Done</Button>
        </header>
        {plan && teams && teamsPrice ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {TIERS.map((tier) => (
              <section key={tier.id} className="rounded-lg border border-hairline p-4">
                <h2 className="font-medium">{tier.name}</h2>
                {plan.plan === tier.id && <div className="mt-1 text-xs text-muted-foreground">Current plan</div>}
                {tier.id === "teams" && (
                  <div className="mt-2 space-y-1 text-sm">
                    <p>{teamsPrice} per seat / {teams.interval}</p>
                    <p className="text-muted-foreground">Up to {teams.memberLimit} members</p>
                  </div>
                )}
              </section>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">Plans are unavailable for this organization.</p>}
      </div>
    </section>
  );
}
