import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Loader2, TriangleAlert } from "@/icons";
import { openExternalWebUrl } from "@/lib/externalUrl";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type CloudProviderConnection, type CloudProviderSummary, type CloudWorkspaceProviderId, type CloudWorkspaceSetup } from "@/lib/api";
import { refreshAccount } from "@/lib/account";
import { COMPUTER_COLORS, COMPUTER_NAME, computerColorCss, computerNameOf, saveComputerIdentity, type ComputerColor } from "@/lib/computerIdentity";
import { listedProviders, pausedProviders } from "@/lib/hiddenProviders";
import { PLATFORM_PROVIDER_NOTE, cloudProviderBilled, cloudProviderIcon, cloudProviderInPlace, cloudProviderIsPlatform, cloudProviderLabel, cloudProviderReady } from "@/lib/cloudProviders";
import { formatMicros } from "@/lib/organizationCompute";
import { cn } from "@/lib/cn";
import { providerActionMessage } from "@/components/settings/ProviderControls";
import { FieldLabel, PrimaryButton, StepActions, StepError, StepPage } from "./FlowLayout";
import type { StepProps } from "./stepProps";
import { hasSecureDialog, SECURE_DIALOG_OFF } from "@/lib/platform";

const DISCLOSURE_VERSION = "cloud-provider-connections-2026-08-13";

const NAME_RULE = "Use 1–40 lowercase letters, digits and hyphens, starting and ending with a letter or digit.";

type Busy = "connect" | "allow" | "save" | null;

/** Hourly prices are fractions of a cent apart: four places, where `formatMicros` rounds to two. */
function hourly(micros: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(micros / 1_000_000);
  } catch {
    return formatMicros(micros, currency);
  }
}

function gigabytes(mebibytes: number): string {
  const value = mebibytes / 1024;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;
}

/** A failure's own message when it has one, else what the provider routes say about it. */
function setupMessage(failure: unknown): string {
  if (typeof failure === "string" && failure) return failure;
  if (failure && typeof failure === "object" && "message" in failure && String((failure as { message: unknown }).message)) return errorMessage(failure);
  return providerActionMessage(failure);
}

function storedColor(color: string | null | undefined): ComputerColor {
  return COMPUTER_COLORS.find((item) => item.id === color)?.id ?? COMPUTER_COLORS[0].id;
}

/**
 * Step 3 (12.03): the compute provider, its region and machine size, and
 * the name and colour the organization's cloud computer shows with. The key
 * is never typed here: the app asks for it in a native secure dialog. A
 * provider TerminalX itself provides (PRO-452) has no key and no connection
 * to read: it shows as ready, with its regions and sizes, and nothing to
 * connect or replace. The provider, region and size are kept on the setup
 * record for the setup check; the name and colour are saved on Continue.
 * Compute can wait.
 */
export function ComputeStep({ organization, record, onRecord, contextRevision, onContinue }: StepProps) {
  const [providers, setProviders] = useState<CloudProviderSummary[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CloudWorkspaceProviderId | null>(null);
  const [connection, setConnection] = useState<CloudProviderConnection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [setup, setSetup] = useState<CloudWorkspaceSetup | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canEdit = organization.role === "owner" || organization.role === "admin";
  const initialName = computerNameOf(organization);
  const initialColor = storedColor(organization.computerColor);
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState<ComputerColor>(initialColor);
  const [saveError, setSaveError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const providersSeq = useRef(0);
  const detailSeq = useRef(0);
  // The latest props, for a Continue that lands after an await.
  const latest = useRef({ record, onRecord, onContinue });
  latest.current = { record, onRecord, onContinue };

  const loadProviders = useCallback(async (): Promise<CloudProviderSummary[] | null> => {
    const current = ++providersSeq.current;
    try {
      const result = await api.cloudProviders();
      if (!mounted.current || current !== providersSeq.current) return null;
      const listed = listedProviders(result.providers);
      setProviders(listed);
      setProvidersError(null);
      setSelected((shown) => {
        if (shown && listed.some((provider) => provider.id === shown)) return shown;
        const chosen = latest.current.record.machine?.provider;
        // What the organization connected itself comes before a provider that was ready without it.
        return (
          listed.find((provider) => provider.id === chosen) ??
          listed.find((provider) => provider.connection?.state === "connected") ??
          listed.find(cloudProviderReady) ??
          listed.find(cloudProviderInPlace) ??
          listed.find((provider) => provider.availability !== "disabled-for-create") ??
          listed[0]
        )?.id ?? null;
      });
      return result.providers;
    } catch (failure) {
      if (mounted.current && current === providersSeq.current) setProvidersError(providerActionMessage(failure));
      return null;
    }
  }, [organization.id]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const provider = providers?.find((item) => item.id === selected) ?? null;
  // TerminalX provides this one (PRO-452): the list says whether it is ready, and there is no connection to read.
  const platform = cloudProviderIsPlatform(provider);
  const platformReady = platform && provider !== null && cloudProviderReady(provider);

  // The chosen provider's connection, and once it is connected, the regions and sizes it offers.
  useEffect(() => {
    if (!selected) return;
    const current = ++detailSeq.current;
    const fresh = () => mounted.current && current === detailSeq.current;
    setDetailLoading(true);
    setSetupError(null);
    setSetup((shown) => (shown?.provider === selected ? shown : null));
    void (async () => {
      try {
        if (platform) {
          setConnection(null);
          if (!platformReady) {
            setSetup(null);
            return;
          }
        } else {
          const detail = await api.cloudProvider(selected);
          if (!fresh()) return;
          setConnection(detail);
          if (detail.state !== "connected") {
            setSetup(null);
            return;
          }
        }
        try {
          const offered = await api.cloudWorkspaceSetup(selected, organization.id);
          if (fresh()) setSetup(offered);
        } catch (failure) {
          if (fresh()) {
            setSetup(null);
            setSetupError(setupMessage(failure));
          }
        }
      } catch (failure) {
        if (fresh()) {
          setConnection(null);
          setSetup(null);
          setSetupError(providerActionMessage(failure));
        }
      } finally {
        if (fresh()) setDetailLoading(false);
      }
    })();
  }, [selected, reload, organization.id, platform, platformReady]);

  const offered = setup && setup.provider === selected ? setup : null;
  const machine = record.machine?.provider === selected ? record.machine : undefined;
  const locationId = offered ? (offered.locations.some((location) => location.id === machine?.locationId) ? machine!.locationId! : offered.defaults.locationId) : undefined;
  const machineClassId = offered
    ? offered.machineClasses.some((item) => item.id === machine?.machineClassId)
      ? machine!.machineClassId!
      : offered.defaults.machineClassId
    : undefined;

  // The record holds what is shown: the provider, and once its offer is read, the region and size (the defaults until changed).
  useEffect(() => {
    if (!selected) return;
    const current = latest.current.record;
    const base = current.machine?.provider === selected ? current.machine : { provider: selected };
    const next = { ...base, provider: selected, ...(locationId ? { locationId } : {}), ...(machineClassId ? { machineClassId } : {}) };
    const before = current.machine;
    if (before?.provider === next.provider && before.locationId === next.locationId && before.machineClassId === next.machineClassId) return;
    latest.current.onRecord({ ...current, machine: next });
  }, [selected, locationId, machineClassId]);

  const choose = (id: CloudWorkspaceProviderId) => {
    if (id === selected) return;
    setSelected(id);
    setConnection(null);
    setReplacing(false);
    setConsented(false);
    setError(null);
    setNotice(null);
  };

  // A platform provider has no connection to manage: what is left to an owner or admin is allowing its new machines.
  const manage = platform ? Boolean(provider?.canManage) : Boolean(provider?.canManage && connection?.canManage);
  const connected = platform ? platformReady : connection?.state === "connected";
  const paused = provider?.availability === "disabled-for-create";
  const disconnecting = Boolean(connection?.disconnectDisposition || connection?.disconnectRetention === "archive");
  const entering = !platform && manage && !disconnecting && (!connection || connection.state === "not-connected" || replacing);
  const copy = provider?.descriptor ?? null;

  const connect = async () => {
    if (!provider || platform || busy || !consented) return;
    setBusy("connect");
    setError(null);
    setNotice(null);
    try {
      await api.cloudProviderConnect(provider.id, {
        contextRevision,
        disclosure: { version: DISCLOSURE_VERSION, providerBillingAccepted: true, organizationUseAccepted: true },
      });
      if (!mounted.current) return;
      setReplacing(false);
      setConsented(false);
      setNotice(`${provider.displayName} is connected. Connecting a key doesn't create a machine.`);
      await loadProviders();
      setReload((count) => count + 1);
    } catch (failure) {
      if (!mounted.current) return;
      setError(providerActionMessage(failure));
      void loadProviders();
      setReload((count) => count + 1);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  // Allowing new machines is all a paused connection needs (PRO-112).
  const allow = async () => {
    if (!provider || busy) return;
    setBusy("allow");
    setError(null);
    setNotice(null);
    try {
      await api.cloudProviderSetCreationEnabled(provider.id, contextRevision, true);
      const found = await loadProviders();
      if (!mounted.current) return;
      setReload((count) => count + 1);
      // Allowed for the organization, and still not offered: the server is not taking new machines there.
      if (found && pausedProviders(found).some((other) => other.id === provider.id))
        setError(`New machines are allowed for ${organization.name}, but ${provider.displayName} isn't offered for new workspaces right now. Check again later.`);
      else setNotice("New machines are allowed again.");
    } catch (failure) {
      if (mounted.current) setError(providerActionMessage(failure));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const nameValid = COMPUTER_NAME.test(name);
  const identityChanged = canEdit && (name !== initialName || color !== initialColor);

  const goOn = async (saveIdentity: boolean) => {
    if (busy) return;
    if (!saveIdentity || !identityChanged) {
      latest.current.onContinue();
      return;
    }
    if (!nameValid) return;
    setBusy("save");
    setSaveError(null);
    try {
      await saveComputerIdentity(organization.id, contextRevision, name, color);
      await refreshAccount();
      latest.current.onContinue();
    } catch (failure) {
      if (mounted.current) setSaveError(errorMessage(failure));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const shownCss = computerColorCss(color);
  const idleMinutes = offered?.defaults.idleSuspendMinutes ?? 0;
  const billed = provider ? cloudProviderBilled(provider) : false;

  return (
    <StepPage
      title="Choose compute"
      description={
        platform && provider
          ? `${cloudProviderLabel(provider)} runs cloud workspaces on machines TerminalX provides: there is no provider account to connect. TerminalX starts, sleeps and removes them.`
          : "Cloud workspaces run on machines in your own provider account. TerminalX starts, sleeps and removes them; the provider bills you directly."
      }
    >
      {providers === null ? (
        providersError ? (
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="text-destructive">{providersError}</span>
            <Button size="sm" variant="outline" onClick={() => void loadProviders()}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground" role="status">
            <Loader2 className="size-3.5 animate-spin" /> Loading compute providers…
          </div>
        )
      ) : providers.length === 0 ? (
        <p className="rounded-xl border border-hairline bg-card p-4 text-[12.5px] text-muted-foreground">No compute provider is offered to {organization.name} right now. You can go on and connect one later from Settings.</p>
      ) : (
        <div role="radiogroup" aria-label="Compute provider" className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
          {providers.map((item) => {
            const current = item.id === selected;
            const itemCopy = item.descriptor;
            const Icon = cloudProviderIcon(item);
            const state =
              item.availability === "disabled-for-create"
                ? { label: "New machines paused", tone: "text-warning" }
                : item.connection?.state === "attention-required" || item.availability === "attention-required"
                  ? { label: "Needs attention", tone: "text-warning" }
                  : null;
            return (
              <label
                key={item.id}
                data-testid={`cloud-setup-provider-${item.id}`}
                className={cn(
                  "grid cursor-pointer content-start gap-2 rounded-xl border p-3.5 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/40",
                  current ? "border-accent/60 bg-accent/5" : "border-hairline bg-card hover:bg-veil-raised",
                )}
              >
                <input type="radio" name="cloud-setup-provider" className="sr-only" checked={current} onChange={() => choose(item.id)} />
                <span className="flex items-center gap-2">
                  <Icon className={cn("size-4 shrink-0", current ? "text-accent" : "text-muted-foreground")} />
                  <span className="min-w-0 truncate text-[13px] font-medium">{cloudProviderLabel(item)}</span>
                  <span aria-hidden className={cn("ml-auto grid size-4 shrink-0 place-items-center rounded-full border", current ? "border-accent" : "border-hairline")}>
                    {current && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                </span>
                {itemCopy && <span className="text-[12px] leading-[17px] text-muted-foreground">{itemCopy.description}</span>}
                <span className="flex flex-wrap items-center gap-x-2 text-[12px]">
                  {itemCopy && <span className="text-faint">{itemCopy.billing}</span>}
                  {state && (
                    <span className={cn("flex items-center gap-1", state.tone)}>
                      <TriangleAlert className="size-3" />
                      {state.label}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {provider && (
        <>
          <div className="mt-4 grid grid-cols-[1fr_200px] gap-3 max-sm:grid-cols-1">
            <div className="min-w-0">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-medium">{platform ? "Connection" : copy?.credentialFields.map((field) => field.label).join(" · ") || `${cloudProviderLabel(provider)} API token`}</span>
                {/* Replacing the key is a link on the field's own line, not a row of its own (12.03). A platform provider has no key to replace. */}
                {!platform && manage && connection && !entering && !disconnecting && (
                  <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground hover:underline disabled:opacity-60" disabled={Boolean(busy)} onClick={() => setReplacing(true)}>
                    Replace key
                  </button>
                )}
              </div>
              {!platform &&
                copy?.credentialFields
                  .filter((field) => field.helpUrl?.startsWith("https://"))
                  .map((field) => (
                    <button key={field.name} type="button" className="mb-1 text-[12px] text-accent hover:underline" onClick={() => void openExternalWebUrl(field.helpUrl!).catch(() => undefined)}>
                      Where to get the {field.label}
                    </button>
                  ))}
              <div className="flex h-9 min-w-0 items-center gap-2 rounded-md border border-hairline bg-card px-3 text-[12.5px]" data-testid="cloud-setup-provider-connection">
                {platform ? (
                  // The connected row without a key: there is none to show, replace or remove.
                  <>
                    <span className="truncate text-muted-foreground">{PLATFORM_PROVIDER_NOTE} · no key to connect</span>
                    {connected ? (
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-add">
                        <CircleCheck className="size-3.5" /> Ready
                      </span>
                    ) : (
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-warning">
                        <TriangleAlert className="size-3.5" /> Needs attention
                      </span>
                    )}
                  </>
                ) : detailLoading && !connection ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Checking the connection…
                  </span>
                ) : connection && connection.state !== "not-connected" ? (
                  <>
                    <span className="truncate font-mono">
                      {"•".repeat(20)}
                      {connection.credentialFingerprint?.slice(-4) ?? ""}
                    </span>
                    {connected ? (
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-add">
                        <CircleCheck className="size-3.5" />
                        Valid{connection.providerAccount ? ` · ${connection.providerAccount}` : ""}
                      </span>
                    ) : (
                      <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-warning">
                        <TriangleAlert className="size-3.5" /> Needs attention
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-faint">Not connected</span>
                )}
              </div>
            </div>
            <div>
              <FieldLabel htmlFor="cloud-setup-region">Region</FieldLabel>
              <select
                id="cloud-setup-region"
                className="h-9 w-full rounded-md border border-hairline bg-card px-2.5 text-[12.5px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
                disabled={!offered || provider.capabilities.locationSelection === "automatic" || busy === "save"}
                value={locationId ?? ""}
                onChange={(event) => onRecord({ ...record, machine: { ...(machine ?? { provider: provider.id }), provider: provider.id, locationId: event.target.value, ...(machineClassId ? { machineClassId } : {}) } })}
              >
                {!offered && <option value="">{connected ? "Loading…" : platform ? "Unavailable" : "After connecting"}</option>}
                {offered?.locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.label.toLowerCase().includes(location.id.toLowerCase()) ? location.label : `${location.label} · ${location.id}`}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {disconnecting && (
            <p className="mt-2 text-[12.5px] text-warning" role="status">
              A disconnect of {provider.displayName} is under way, so no new machine can start on it. Manage it in Settings.
            </p>
          )}
          {platform && !connected && (
            <p className="mt-2 text-[12.5px] text-warning" role="status" data-testid="cloud-setup-provider-platform-attention">
              {provider.displayName} isn't available to {organization.name} right now. TerminalX provides it, so there is no key to replace here. Check again later, or contact TerminalX support.
            </p>
          )}
          {paused && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]" role="status" data-testid="cloud-setup-provider-paused">
              <span className="text-warning">New machines are paused on {provider.displayName}.</span>
              <span className="text-muted-foreground">
                {manage ? "Existing workspaces keep running; nobody can create a new one here until you allow it." : "An organization owner or administrator can allow new machines again."}
              </span>
              {manage && (
                <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void allow()}>
                  {busy === "allow" && <Loader2 className="animate-spin" />}
                  Allow new machines
                </Button>
              )}
            </div>
          )}
          {connection && !manage && (
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              {connected ? "Organization owners and administrators manage provider keys." : `Ask an owner or administrator of ${organization.name} to connect ${provider.displayName}.`}
            </p>
          )}
          {entering && connection && (
            <div className="mt-3 rounded-lg border border-hairline bg-raised p-3" data-testid="cloud-setup-provider-connect">
              <p className="text-[12.5px] leading-[19px] text-muted-foreground">
                A secure system dialog asks for the key, so it never passes through this window. It is saved only after {provider.displayName} accepts it
                {connection.state !== "not-connected" ? ", and only for the same provider account" : ""}.
              </p>
              {!hasSecureDialog && <p role="note" className="mt-2 text-[12.5px] leading-[19px] text-warning">{SECURE_DIALOG_OFF}</p>}
              <label className="mt-2.5 flex items-start gap-2 text-[12.5px] leading-[19px]">
                <input type="checkbox" className="mt-[3px]" checked={consented} disabled={busy === "connect"} onChange={(event) => setConsented(event.target.checked)} />
                <span>
                  I understand {provider.displayName} bills {organization.name}'s provider account directly, and that everyone in {organization.name} can start workspaces with this connection.
                </span>
              </label>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={!consented || Boolean(busy) || !hasSecureDialog} onClick={() => void connect()}>
                  {busy === "connect" && <Loader2 className="animate-spin" />}
                  {connection.state === "not-connected" ? `Connect ${provider.displayName}` : "Enter the new key"}
                </Button>
                {replacing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === "connect"}
                    onClick={() => {
                      setReplacing(false);
                      setConsented(false);
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
          <StepError>{error}</StepError>
          {notice && !error && (
            <p role="status" className="mt-2 text-[12.5px] text-muted-foreground">
              {notice}
            </p>
          )}

          <div className="mt-4 mb-1.5 text-[12.5px] font-medium">
            Machine size
            {offered && <span className="font-normal text-faint"> · {offered.pricing === "provider-rate" ? `prices from ${provider.displayName}` : "estimated prices"}</span>}
          </div>
          {offered ? (
            offered.machineClasses.length ? (
              <div role="radiogroup" aria-label="Machine size" className="overflow-hidden rounded-lg border border-hairline bg-card">
                {offered.machineClasses.map((item, index) => {
                  const current = item.id === machineClassId;
                  return (
                    <label
                      key={item.id}
                      className={cn(
                        "flex h-10 cursor-pointer items-center gap-3 px-3 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/40 has-[input:focus-visible]:ring-inset",
                        index > 0 && "border-t border-hairline",
                        current ? "bg-selected" : "hover:bg-veil-raised",
                      )}
                    >
                      <input
                        type="radio"
                        name="cloud-setup-machine-size"
                        className="sr-only"
                        checked={current}
                        disabled={busy === "save"}
                        onChange={() => onRecord({ ...record, machine: { ...(machine ?? { provider: provider.id }), provider: provider.id, ...(locationId ? { locationId } : {}), machineClassId: item.id } })}
                      />
                      <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center rounded-full border", current ? "border-accent" : "border-hairline")}>
                        {current && <span className="size-2 rounded-full bg-accent" />}
                      </span>
                      <span className="w-[64px] shrink-0 truncate font-mono text-[12.5px]">{item.label}</span>
                      <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">
                        {item.vcpu} vCPU · {gigabytes(item.memoryMiB)} · {item.diskGiB} GB
                      </span>
                      {item.id === offered.defaults.machineClassId && (
                        <span className="inline-flex h-5 shrink-0 items-center rounded bg-accent/15 px-1.5 text-[11.5px] whitespace-nowrap text-accent">Recommended</span>
                      )}
                      <span className="ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">
                        {item.activeHourlyMicros === null ? "price unavailable" : `${hourly(item.activeHourlyMicros, offered.currency)} / h`}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-hairline bg-card px-3 py-2.5 text-[12.5px] text-muted-foreground">{provider.displayName} offers no machine sizes right now.</p>
            )
          ) : (
            <div className="rounded-lg border border-dashed border-hairline px-3 py-3 text-[12.5px] text-muted-foreground">
              {setupError ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-destructive">{setupError}</span>
                  <Button size="xs" variant="outline" onClick={() => setReload((count) => count + 1)}>
                    Try again
                  </Button>
                </span>
              ) : connected ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" /> Loading {provider.displayName}'s regions and machine sizes…
                </span>
              ) : platform ? (
                `Regions, machine sizes and prices show here once ${provider.displayName} is available again.`
              ) : (
                `Regions, machine sizes and ${provider.displayName}'s prices show here once it is connected.`
              )}
            </div>
          )}
        </>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-6">
        <div>
          <FieldLabel htmlFor="cloud-setup-computer-name">Computer name and colour</FieldLabel>
          <div className="flex items-center gap-3">
            <input
              id="cloud-setup-computer-name"
              className="h-9 w-[180px] rounded-md border border-hairline bg-card px-3 font-mono text-[12.5px] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60 aria-invalid:border-destructive"
              value={name}
              maxLength={40}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              readOnly={!canEdit}
              disabled={busy === "save"}
              aria-invalid={canEdit && !nameValid}
              aria-describedby={!canEdit || !nameValid ? "cloud-setup-computer-name-help" : undefined}
              onChange={(event) => {
                setName(event.target.value.toLowerCase());
                setSaveError(null);
              }}
            />
            <div role="radiogroup" aria-label="Computer colour" className="flex items-center gap-1">
              {COMPUTER_COLORS.map((item) => {
                const current = item.id === color;
                return (
                  <label
                    key={item.id}
                    title={item.label}
                    className={cn(
                      "grid size-6 place-items-center rounded-full border-2 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring/40",
                      current ? "border-foreground" : "border-transparent",
                      canEdit ? "cursor-pointer" : "cursor-default",
                    )}
                  >
                    <input
                      type="radio"
                      name="cloud-setup-computer-colour"
                      className="sr-only"
                      aria-label={item.label}
                      checked={current}
                      disabled={!canEdit || busy === "save"}
                      onChange={() => {
                        setColor(item.id);
                        setSaveError(null);
                      }}
                    />
                    <span aria-hidden className="size-[18px] rounded-full" style={{ background: item.css }} />
                  </label>
                );
              })}
            </div>
          </div>
        </div>
        <div className="ml-auto flex h-9 items-center gap-2 rounded-md border border-hairline bg-raised px-3 text-[12px]" data-testid="cloud-setup-computer-chip">
          <span className="text-faint">Shows as</span>
          <span className="flex h-6 items-center gap-1.5 rounded-md px-2 font-mono text-[12px]" style={{ background: `color-mix(in oklab, ${shownCss} 15%, transparent)`, color: shownCss }}>
            <span aria-hidden className="size-2 rounded-full" style={{ background: shownCss }} />
            {name || initialName}
          </span>
        </div>
      </div>
      {/* The "Shows as" chip already says how everyone sees the name (12.03); a line shows only for a rule or a restriction. */}
      {(!canEdit || !nameValid) && (
        <p id="cloud-setup-computer-name-help" className={cn("mt-1.5 text-[12px]", canEdit ? "text-destructive" : "text-faint")}>
          {!canEdit ? `Owners and admins of ${organization.name} choose the computer's name and colour.` : NAME_RULE}
        </p>
      )}

      <p className="mt-3 text-[12px] leading-[18px] text-faint">
        {idleMinutes > 0 && provider?.capabilities.suspend ? `Idle workspaces sleep after ${idleMinutes} minutes. ` : ""}
        {billed ? "Stopped disks and snapshots keep charging until they're deleted, and provider bills can arrive late." : ""}
      </p>

      <StepActions note={platform ? "Choosing compute doesn't create a machine" : "Connecting a token doesn't create a machine"}>
        <PrimaryButton busy={busy === "save"} disabled={Boolean(busy) || (identityChanged && !nameValid)} onClick={() => void goOn(true)}>
          Continue
        </PrimaryButton>
      </StepActions>
      {saveError && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-xs text-destructive">
            The name and colour were not saved: {saveError}
          </p>
          <Button size="xs" variant="ghost" disabled={Boolean(busy)} onClick={() => void goOn(false)}>
            Go on without saving them
          </Button>
        </div>
      )}
    </StepPage>
  );
}
