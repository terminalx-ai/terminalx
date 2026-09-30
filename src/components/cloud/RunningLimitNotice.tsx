import { useState } from "react";
import { Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { actionsFor } from "@/components/cloud/CloudWorkspaceLifecycle";
import { WorkspaceLifecycleDialog, type LifecycleRequest } from "@/components/cloud/WorkspaceActions";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { runningWorkspaces } from "@/lib/runningLimit";

/**
 * After a refusal at the running limit: the organization's running
 * workspaces, from the catalog (nothing is fetched or woken), each with Stop
 * where it can be stopped. Stop goes through the usual confirmation, which
 * checks for agent work first.
 */
export function RunningLimitNotice({ orgId, exceptId }: { orgId: string; exceptId?: string }) {
  const catalog = useCloudCatalog();
  const [request, setRequest] = useState<LifecycleRequest | null>(null);
  const running = runningWorkspaces(orgId, catalog, exceptId);
  if (!running.length) return null;
  return (
    <div className="mt-2 rounded-md border border-hairline px-3 py-2 text-xs" role="group" aria-label="Running cloud workspaces" data-testid="running-limit-notice">
      <div className="mb-1 text-muted-foreground">Running now:</div>
      <ul className="flex flex-col gap-1">
        {running.map((item) => (
          <li key={item.workspace.id} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-foreground">{item.workspace.name}</span>
            {actionsFor(item).includes("stop") ? (
              <Button size="sm" variant="outline" className="h-6 shrink-0 px-2" onClick={() => setRequest({ item, action: "stop" })}>
                <Pause className="size-3" /> Stop
              </Button>
            ) : (
              <span className="shrink-0 text-muted-foreground">Starting or stopping</span>
            )}
          </li>
        ))}
      </ul>
      {request && <WorkspaceLifecycleDialog request={request} onClose={() => setRequest(null)} />}
    </div>
  );
}
