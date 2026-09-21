import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  api,
  type CloudProviderConnection,
  type CloudProviderSummary,
} from "@/lib/api";

export function providerActionMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  switch (code) {
    case "cloud_provider_account_mismatch":
      return "This key belongs to a different provider account. Existing resources keep their original ownership. Use a key from the original account to clean up resources; migrate them in the provider console before changing accounts.";
    case "cloud_provider_credential_invalid":
      return "Validation failed. The saved credential was not replaced. Ask an organization administrator to validate a working key for the original provider account.";
    case "cloud_provider_operation_in_progress":
      return "A provider operation is still running. Its credential remains available. Refresh and retry after the operation finishes.";
    case "cloud_provider_connection_required":
    case "cloud_provider_connection_attention_required":
      return "An organization administrator must repair this provider connection. Existing resources may still incur charges.";
    case "organization_admin_required":
      return "Only an organization owner or administrator can manage this connection.";
    case "cloud_provider_entry_cancelled":
      return "Key entry canceled. The saved connection is unchanged.";
    case "account_context_changed":
      return "The account or organization changed. Refresh before trying again.";
    default:
      return "The provider request could not be confirmed. Refresh to check its status, then retry. Existing resources may still incur charges.";
  }
}

export function ProviderControls({
  contextRevision,
}: {
  contextRevision: string;
}) {
  const [providers, setProviders] = useState<CloudProviderSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [connection, setConnection] = useState<CloudProviderConnection | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [consented, setConsented] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disposition, setDisposition] = useState<"retain" | "destroy" | "">("");
  const epoch = useRef(0);
  const provider = providers.find((item) => item.id === selected);

  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    try {
      const result = await api.cloudProviders();
      const next =
        result.providers.find((item) => item.id === selected) ??
        result.providers[0];
      const detail = next ? await api.cloudProvider(next.id) : null;
      if (request !== epoch.current) return;
      setProviders(result.providers);
      setSelected(next?.id ?? "");
      setConnection(detail);
    } catch (failure) {
      if (request === epoch.current) {
        setError(providerActionMessage(failure));
        setConnection(null);
      }
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  const manage = Boolean(
    provider?.canManage && connection?.canManage && !loading,
  );
  const run = async (action: () => Promise<unknown>) => {
    if (!manage || busy) return;
    const request = epoch.current;
    setBusy(true);
    setError(null);
    setConsented(false);
    try {
      await action();
      if (request !== epoch.current) return;
      setReplacing(false);
      setConsented(false);
      setDisconnecting(false);
      setDisposition("");
      await refresh();
    } catch (failure) {
      if (request === epoch.current) {
        setError(providerActionMessage(failure));
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const connected = connection?.state === "connected";
  const setupComplete =
    connected &&
    !connection?.operationsBlocked &&
    !connection?.disconnectDisposition;
  const resources = connection?.resources ?? [];
  const hasContract =
    connection?.credentialVersion != null && connection.resources != null;
  return (
    <div className="mt-3 space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <label className="flex-1">
          Provider
          <select
            aria-label="Provider"
            className="mt-1 h-8 w-full rounded-md border border-hairline bg-background px-2"
            value={selected}
            disabled={busy || loading}
            onChange={(event) => {
              setSelected(event.target.value);
              setConnection(null);
              setReplacing(false);
              setConsented(false);
              setDisconnecting(false);
              setDisposition("");
              setError(null);
            }}
          >
            {!providers.length && (
              <option value="">No providers available</option>
            )}
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || loading}
          onClick={() => {
            setError(null);
            void refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {loading ? (
        <p role="status">Loading provider connection…</p>
      ) : (
        <>
          <p role="status" className="font-medium">
            {connection?.disconnectDisposition &&
            connection.state !== "not-connected"
              ? "Disconnect pending — new provisioning blocked"
              : setupComplete
                ? "Setup complete — compute connection validated"
                : connection?.state === "not-connected"
                  ? "Compute setup incomplete — connect a provider"
                  : "Compute setup incomplete — provider needs attention"}
          </p>
          <p className="text-muted-foreground">
            {setupComplete
              ? "Next: create a cloud workspace. Choose its configuration and review provider charges before launching. Connecting a key does not create a machine."
              : "Your organization remains usable without cloud compute. Finish setup here later; no machine is created by connecting a key."}
          </p>
          {!manage && (
            <p className="text-muted-foreground">
              {connected
                ? "Organization owners and administrators manage provider keys."
                : "Ask an organization administrator to repair the provider connection. Only organization owners and administrators can manage provider keys."}
            </p>
          )}
          {manage && connection && (
            <>
              <dl className="grid grid-cols-[8rem_1fr] gap-1 text-muted-foreground">
                <dt>Credential version</dt>
                <dd>{connection.credentialVersion ?? "Unavailable"}</dd>
                <dt>Provider account</dt>
                <dd className="break-all">
                  {connection.providerAccount ??
                    "Identity unavailable — use the original account"}
                </dd>
                <dt>Last validated</dt>
                <dd>
                  {connection.lastValidatedAt
                    ? new Date(connection.lastValidatedAt).toLocaleString()
                    : "Not validated"}
                </dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(true);
                    setDisconnecting(false);
                  }}
                >
                  {connection.state === "not-connected"
                    ? "Connect provider"
                    : "Replace / validate key"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !hasContract}
                  onClick={() => {
                    setDisconnecting(true);
                    setReplacing(false);
                    setDisposition("");
                  }}
                >
                  {connection.disconnectDisposition &&
                  connection.state !== "not-connected"
                    ? "Retry disconnect / cleanup"
                    : "Disconnect"}
                </Button>
              </div>
              {!hasContract && (
                <p className="text-muted-foreground">
                  Disconnect controls require the updated provider service with
                  resource and ownership metadata.
                </p>
              )}
              {replacing && (
                <div className="space-y-2 rounded-md border border-hairline p-3">
                  <p>
                    A native secure dialog collects the key. It is activated
                    only after validation against the original provider account.
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={consented}
                      disabled={busy}
                      onChange={(event) => setConsented(event.target.checked)}
                    />
                    I understand provider billing and organization use.
                  </label>
                  <Button
                    size="sm"
                    disabled={busy || !consented}
                    onClick={() =>
                      void run(() =>
                        api.cloudProviderConnect(provider!.id, {
                          contextRevision,
                          disclosure: {
                            version: "cloud-provider-connections-2026-08-13",
                            providerBillingAccepted: true,
                            organizationUseAccepted: true,
                          },
                        }),
                      )
                    }
                  >
                    Validate and save key
                  </Button>
                </div>
              )}
              <div className="space-y-2 rounded-md border border-hairline p-3">
                <div className="font-medium">
                  Resources and remaining charges
                </div>
                <p className="text-muted-foreground">
                  Quoted estimates are not a live bill. Running compute,
                  retained storage and archived resources can continue to incur
                  provider charges until cleanup is confirmed.
                </p>
                {resources.length ? (
                  resources.map((resource) => (
                    <div
                      key={resource.id}
                      className="border-t border-hairline pt-2"
                    >
                      <div className="font-medium">
                        {resource.name} — {resource.state}
                      </div>
                      <p className="text-muted-foreground">
                        {resource.activeHourlyMicros == null
                          ? "Compute charges unknown"
                          : `${resource.currency} ${(resource.activeHourlyMicros / 1e6).toFixed(4)}/hour active`}
                        ;{" "}
                        {resource.suspendedMonthlyMicros == null
                          ? "storage charges unknown"
                          : `${resource.currency} ${(resource.suspendedMonthlyMicros / 1e6).toFixed(2)}/month suspended`}
                        .
                      </p>
                      {resource.operationState && (
                        <p>
                          Operation: {resource.operationState}
                          {resource.cleanupRequired
                            ? " · Cleanup unresolved"
                            : ""}
                        </p>
                      )}
                      {(resource.kind !== "workspace" ||
                        resource.releaseDisposition === "archived" ||
                        resource.releaseDisposition === "terminalx-only") && (
                        <p>
                          Provider console cleanup or migration is required;
                          retain the connection until confirmed.
                        </p>
                      )}
                    </div>
                  ))
                ) : (
                  <p>No unresolved resources reported by the service.</p>
                )}
              </div>
              {disconnecting && (
                <div className="space-y-2 rounded-md border border-destructive/25 p-3">
                  <p>
                    Disconnect blocks new provisioning. Existing operations
                    retain access until resolved. Choose what happens to
                    resources:
                  </p>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="disposition"
                      checked={disposition === "retain"}
                      onChange={() => setDisposition("retain")}
                      disabled={busy}
                    />
                    Retain resources — I accept remaining provider charges.
                  </label>
                  <label className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="disposition"
                      checked={disposition === "destroy"}
                      onChange={() => setDisposition("destroy")}
                      disabled={busy}
                    />
                    Destroy resources — queue cleanup and keep failures visible
                    for retry.
                  </label>
                  <p className="text-muted-foreground">
                    If credentials are unavailable, restore a key from the
                    original account and retry cleanup. Retained resources keep
                    their original ownership.
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || !disposition}
                    onClick={() =>
                      void run(() =>
                        api.cloudProviderDisconnect(
                          provider!.id,
                          contextRevision,
                          disposition as "retain" | "destroy",
                        ),
                      )
                    }
                  >
                    Confirm disconnect
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
