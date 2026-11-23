import { useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import type { CloudProviderSummary } from "@/lib/api";
import { getAccount } from "@/lib/account";
import { CreateRefused, createErrorMessage } from "@/lib/cloudCreate";
import { allowNewMachines } from "@/lib/hiddenProviders";
import { providerActionMessage } from "@/components/settings/ProviderControls";

/**
 * "Allow new machines" for the paused providers a person may manage (PRO-372),
 * where a create was refused for them: the new-workspace form and New Session.
 * Nothing shows without one, or without the active organization's context.
 */
export function AllowNewMachines({ providers, onAllowed }: { providers: readonly CloudProviderSummary[]; onAllowed: (providers: CloudProviderSummary[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowable = providers.filter((provider) => provider.canManage);
  if (!allowable.length || !getAccount().status.context?.revision) return null;
  const allow = async (provider: CloudProviderSummary) => {
    setBusy(true);
    setError(null);
    try {
      onAllowed(await allowNewMachines(provider));
    } catch (failure) {
      setError(failure instanceof CreateRefused ? createErrorMessage(failure.code, failure.detail, true) : providerActionMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="allow-new-machines">
      <div className="flex flex-wrap gap-2">
        {allowable.map((provider) => (
          <Button key={provider.id} type="button" size="sm" disabled={busy} onClick={() => void allow(provider)}>
            {busy ? <Loader2 className="animate-spin" /> : allowable.length > 1 ? `Allow new machines on ${provider.displayName}` : "Allow new machines"}
          </Button>
        ))}
      </div>
      {error && (
        <p className="text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
