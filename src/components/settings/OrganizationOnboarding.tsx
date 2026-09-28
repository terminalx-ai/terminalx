import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type OrganizationSummary } from "@/lib/api";
import { refreshAccount } from "@/lib/account";
import { ProviderControls } from "./ProviderControls";

type Attempt = { name: string; key: string; organizationId?: string };

export function OrganizationOnboarding({
  organizationName,
  accountEmail,
  contextRevision,
  organizations,
}: {
  organizationName: string | null;
  accountEmail: string;
  contextRevision: string;
  organizations: OrganizationSummary[];
}) {
  const storageKey = `terminalx.organization-setup.v1.${accountEmail}`;
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      return saved &&
        typeof saved.name === "string" &&
        typeof saved.key === "string" &&
        (saved.organizationId === undefined ||
          typeof saved.organizationId === "string")
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const [name, setName] = useState(attempt?.name ?? "");
  const flight = useRef(false);
  const [createOpen, setCreateOpen] = useState(Boolean(attempt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftStorageKey = `${storageKey}.name`;
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
    if (
      attempt?.organizationId &&
      organizations.some(
        (org) =>
          org.id === attempt.organizationId && org.name === organizationName,
      )
    ) {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(draftStorageKey);
      setAttempt(null);
      setName("");
      setCreateOpen(false);
    }
  }, [attempt, organizations, organizationName, storageKey, draftStorageKey]);
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
      const next = attempt ?? { name: name.trim(), key: crypto.randomUUID() };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAttempt(next);
      if (next.organizationId) {
        await api.organizationSelect(next.organizationId, contextRevision);
      } else {
        const organization = await api.organizationCreate(next.name, next.key);
        const saved = { ...next, organizationId: organization.id };
        localStorage.setItem(storageKey, JSON.stringify(saved));
        if (!mounted.current || epoch !== identityEpoch.current) return;
        setAttempt(saved);
      }
      if (!mounted.current || epoch !== identityEpoch.current) return;
      await refreshAccount();
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
          Organization
          <select
            aria-label="Organization"
            className="mt-1 h-8 w-full rounded-md border border-hairline bg-background px-2 text-xs"
            disabled={busy}
            value={
              organizations.find((item) => item.name === organizationName)
                ?.id ?? ""
            }
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
        <ProviderControls
          key={`${accountEmail}:${contextRevision}:${organizationName}`}
          contextRevision={contextRevision}
        />
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
