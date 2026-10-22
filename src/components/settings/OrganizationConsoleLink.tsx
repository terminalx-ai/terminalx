import { useState } from "react";
import { ExternalLink } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";

/**
 * API keys and webhooks of the public cloud API (PRO-40) are managed in the
 * web console, not here: a row that opens this organization's console page
 * in the system browser. Owners and admins only, who are the ones the
 * console lets manage them; a member sees nothing.
 */
export function OrganizationConsoleLink({ organizationId, organizationName, member }: { organizationId: string; organizationName: string; member: boolean }) {
  const [error, setError] = useState<string | null>(null);
  if (member) return null;

  const open = async () => {
    setError(null);
    try {
      await api.organizationConsoleOpen(organizationId);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-hairline p-3" data-testid="organization-console-link">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">API keys and webhooks</div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Integration keys for the public API and webhook endpoints of {organizationName} are managed in the web console.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={() => void open()}>
        <ExternalLink /> Manage in the console
      </Button>
    </div>
  );
}
