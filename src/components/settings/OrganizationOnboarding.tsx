import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type OrganizationSummary } from "@/lib/api";
import { refreshAccount } from "@/lib/account";
import { loadSetups, newSetup, saveSetup, setupFor, unfinishedCreation, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { OrganizationSetupSteps } from "./OrganizationSetupSteps";
import { ProviderControls } from "./ProviderControls";

export function OrganizationOnboarding({
  organizationName,
  organizationId = null,
  accountEmail,
  contextRevision,
  organizations,
  multiOrg = false,
}: {
  organizationName: string | null;
  /** The selected organization's id. A setup record is matched by it, never by name. */
  organizationId?: string | null;
  accountEmail: string;
  contextRevision: string;
  organizations: OrganizationSummary[];
  /** Every organization is live in the sidebar (CS-18): the selection only picks the default for new cloud work. */
  multiOrg?: boolean;
}) {
  // The selected organization, by id. A status that only names it is
  // trusted when exactly one organization has that name: a setup record is
  // never matched to an organization by a name two of them share.
  const named = organizations.filter((item) => item.name === organizationName);
  const activeId = organizationId ?? (named.length === 1 ? named[0]!.id : null);
  // With every organization live (CS-18) the selection only picks where new cloud work starts by default.
  const organizationLabel = multiOrg ? "Default organization for new cloud work" : "Organization";
  // This user's setup records (PRO-16): one per creation request, each bound
  // to its organization once the server has created it.
  const [records, setRecords] = useState<OrganizationSetupRecord[]>(() => loadSetups(accountEmail));
  const persist = (record: OrganizationSetupRecord) => {
    saveSetup(accountEmail, record);
    setRecords(loadSetups(accountEmail));
  };
  // A creation that is requested, or created and never selected. It belongs
  // to its own organization: whichever one is active does not consume it.
  const attempt = unfinishedCreation(records, activeId);
  const setup = setupFor(records, activeId);
  const [name, setName] = useState(attempt?.name ?? "");
  const flight = useRef(false);
  const [createOpen, setCreateOpen] = useState(Boolean(attempt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftStorageKey = `terminalx.organization-setup.v1.${accountEmail}.name`;
  const identityEpoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    identityEpoch.current += 1;
    setBusy(false);
    setError(null);
  }, [accountEmail, organizationName, contextRevision]);
  useEffect(() => {
    if (!attempt) setName(localStorage.getItem(draftStorageKey) ?? "");
  }, [draftStorageKey, attempt]);

  const create = async () => {
    if (flight.current) return;
    flight.current = true;
    const epoch = identityEpoch.current;
    setBusy(true);
    setError(null);
    try {
      // Freeze the logical request across refreshes and failed profile selection.
      const next = attempt ?? newSetup(name.trim(), crypto.randomUUID());
      persist(next);
      let unselected = false;
      if (next.organizationId) {
        // Created earlier: only select it. Creation is never run again.
        await api.organizationSelect(next.organizationId, contextRevision);
        // Selected now; steps it had already passed are kept.
        if (next.step === "select") persist({ ...next, step: "compute" });
      } else {
        const created = await api.organizationCreate(next.name, next.requestId);
        const selected = created.selected !== false;
        persist({ ...next, organizationId: created.id, step: selected ? "compute" : "select" });
        unselected = !selected;
      }
      localStorage.removeItem(draftStorageKey);
      if (!mounted.current || epoch !== identityEpoch.current) return;
      await refreshAccount();
      if (unselected && mounted.current && epoch === identityEpoch.current)
        setError("The organization was created, but could not be selected. Resume setup to select it; it will not be created again.");
    } catch (failure) {
      if (mounted.current && epoch === identityEpoch.current)
        setError(errorMessage(failure));
    } finally {
      flight.current = false;
      if (mounted.current && epoch === identityEpoch.current) setBusy(false);
    }
  };

  if (!organizationName) {
    return (
      <div className="rounded-lg border border-hairline p-3">
        <div className="text-sm font-medium">Create an organization</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Organization setup is incomplete. Create one to configure compute
          access; no machine is created by this step.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Organization name"
            className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs"
            value={name}
            disabled={busy || Boolean(attempt)}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              globalThis.localStorage?.setItem(draftStorageKey, value);
            }}
          />
          <Button
            size="sm"
            disabled={busy || name.trim().length < 2}
            onClick={() => void create()}
          >
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : attempt ? (
              "Resume setup"
            ) : (
              "Continue"
            )}
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="text-sm font-medium">Organization setup</div>
      <p className="mt-1 text-xs text-muted-foreground">
        Organization details → Compute connection → Setup completion
      </p>
      {organizations.length > 1 && (
        <label className="mt-2 block text-xs text-muted-foreground">
          {organizationLabel}
          <select
            aria-label={organizationLabel}
            className="mt-1 h-8 w-full rounded-md border border-hairline bg-background px-2 text-xs"
            disabled={busy}
            value={activeId ?? ""}
            onChange={(event) => {
              const revision = contextRevision;
              void api
                .organizationSelect(event.target.value, revision)
                .then(refreshAccount)
                .catch((failure) => setError(errorMessage(failure)));
            }}
          >
            <option value="">Select organization</option>
            {organizations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.role})
              </option>
            ))}
          </select>
        </label>
      )}
      {attempt ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Resume setup for {attempt.name} to select that organization before
          connecting compute.
        </p>
      ) : (
        <>
          <ProviderControls
            key={`${accountEmail}:${contextRevision}:${organizationName}`}
            contextRevision={contextRevision}
          />
          {setup && activeId && (
            <OrganizationSetupSteps
              key={`${accountEmail}:${contextRevision}:${activeId}`}
              record={setup}
              organizationId={activeId}
              onRecord={persist}
            />
          )}
        </>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-4 border-t border-hairline pt-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const opening = !createOpen;
            setCreateOpen(opening);
            if (opening)
              setName(
                attempt?.name ?? localStorage.getItem(draftStorageKey) ?? "",
              );
          }}
        >
          {createOpen
            ? "Hide organization creation"
            : "Create or switch organization"}
        </Button>
        {createOpen && (
          <>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Create another organization and continue setup there. Existing
              organization access is unchanged.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                aria-label="New organization name"
                className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs"
                value={name}
                disabled={busy || Boolean(attempt)}
                onChange={(event) => {
                  const value = event.target.value;
                  setName(value);
                  globalThis.localStorage?.setItem(draftStorageKey, value);
                }}
              />
              <Button
                size="sm"
                disabled={busy || name.trim().length < 2}
                onClick={() => void create()}
              >
                {busy ? (
                  <Loader2 className="animate-spin" />
                ) : attempt ? (
                  "Resume setup"
                ) : (
                  "Continue"
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
