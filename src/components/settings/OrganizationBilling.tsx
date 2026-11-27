import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, type OrganizationBilling as Billing, type OrganizationSummary } from "@/lib/api";
import { polarPortalUrl } from "@/lib/consoleUrl";
import { PRIVACY_MESSAGE, useDataPrivacy } from "@/lib/dataPrivacy";
import { openPlans } from "@/lib/sessions";

const PLAN_NAME: Record<Billing["plan"], string> = { free: "Free", pro: "Pro", teams: "Teams" };

function money(amountMinor: number, currency: string) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
}

function day(iso: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

function unavailable(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "organization_billing_unavailable";
}

type Load = { state: "loading" } | { state: "ready"; billing: Billing } | { state: "empty" } | { state: "failed" };

/**
 * An organization's Billing page (PRO-596, design 12.15): plan, seats and the
 * next charge, all read from the server. Payment methods and invoices stay in
 * the Polar customer portal, which only the payer can open.
 */
export function OrganizationBilling({ organization, contextRevision }: { organization: OrganizationSummary; contextRevision: string }) {
  const privacy = useDataPrivacy();
  const hidden = !privacy.ready || privacy.enabled;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [opening, setOpening] = useState(false);
  const [portalError, setPortalError] = useState(false);

  const read = useCallback(async (live: () => boolean) => {
    setLoad({ state: "loading" });
    try {
      const billing = await api.organizationBilling(organization.id);
      if (live()) setLoad({ state: "ready", billing });
    } catch (error) {
      if (live()) setLoad(unavailable(error) ? { state: "empty" } : { state: "failed" });
    }
  }, [organization.id]);

  useEffect(() => {
    if (hidden) return;
    let live = true;
    void read(() => live);
    return () => { live = false; };
  }, [hidden, read, contextRevision]);

  if (hidden) return <p className="text-sm text-muted-foreground">{PRIVACY_MESSAGE}</p>;
  if (load.state === "loading") {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />Loading billing…</p>;
  }
  if (load.state === "empty") {
    return <p className="text-sm text-muted-foreground" data-testid="organization-billing-empty">No billing details for this organization yet.</p>;
  }
  if (load.state === "failed") {
    return (
      <div className="flex items-center gap-3 text-sm" role="alert">
        <span className="text-muted-foreground">Couldn't load billing.</span>
        <Button size="sm" variant="outline" onClick={() => void read(() => true)}>Retry</Button>
      </div>
    );
  }

  const { billing } = load;
  const teams = billing.plan === "teams";
  const paid = billing.plan !== "free";
  const seatShare = billing.seats ? Math.min(100, Math.round((billing.seats.used / billing.seats.limit) * 100)) : 0;

  const openPortal = async () => {
    setOpening(true);
    setPortalError(false);
    try {
      const url = polarPortalUrl(await api.organizationBillingPortal(organization.id, billing.billedTo));
      if (!url) throw new Error("portal");
      await openUrl(url);
    } catch {
      setPortalError(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="flex flex-col gap-5" data-testid="organization-billing">
      <p className="-mt-2 text-[13px] text-muted-foreground">Cloud compute is billed by your provider, not here.</p>
      <section aria-label="Plan" className={teams ? "rounded-xl border border-accent/50 p-4" : "rounded-xl border border-hairline p-4"}>
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold">{PLAN_NAME[billing.plan]}</h3>
          {paid && <span className="rounded bg-add/15 px-1.5 py-0.5 text-[11px] text-add">Active</span>}
          {organization.plan && <Button className="ml-auto" size="sm" variant="outline" onClick={() => openPlans()}>Change plan</Button>}
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-4 text-[13px] sm:grid-cols-3">
          {billing.seats && <div>
            <dt className="text-xs text-muted-foreground">Seats</dt>
            <dd className="mt-1">{billing.seats.used} of {billing.seats.limit} used</dd>
            <dd className="mt-2 h-1 overflow-hidden rounded-full bg-veil-strong" aria-hidden>
              <div className="h-full rounded-full bg-accent" style={{ width: `${seatShare}%` }} />
            </dd>
          </div>}
          <div>
            <dt className="text-xs text-muted-foreground">Next charge</dt>
            <dd className="mt-1">{billing.nextCharge ? `${money(billing.nextCharge.amountMinor, billing.nextCharge.currency)} on ${day(billing.nextCharge.date)}` : "None scheduled"}</dd>
            {billing.seatPrice && <dd className="mt-1 text-xs text-muted-foreground">{money(billing.seatPrice.unitAmountMinor, billing.seatPrice.currency)} per seat each month</dd>}
          </div>
          {billing.payer && <div>
            <dt className="text-xs text-muted-foreground">Paid by</dt>
            <dd className="mt-1 truncate">{billing.payer}</dd>
          </div>}
        </dl>
      </section>
      {teams && <div className="flex items-start justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <div className="text-[13px] font-medium">Seats follow members</div>
          <p className="mt-0.5 text-xs text-muted-foreground">Accepting an invite adds a seat; removing someone frees one, prorated.</p>
        </div>
        <span className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[11px] text-muted-foreground">Automatic</span>
      </div>}
      {billing.canManageBilling && <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium">Payment method</div>
          <p className="mt-0.5 text-xs text-muted-foreground">Cards and invoices are managed on Polar.</p>
          {portalError && <p role="alert" className="mt-1 text-xs text-destructive">Couldn't open the payment portal. Try again.</p>}
        </div>
        <Button size="sm" variant="outline" disabled={opening} onClick={() => void openPortal()}>
          {opening ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          Manage payment
        </Button>
      </div>}
    </div>
  );
}
