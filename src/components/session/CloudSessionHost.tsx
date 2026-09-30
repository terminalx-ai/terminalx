import { Button } from "@/components/ui/button";
import { useAccount } from "@/lib/account";
import { useCloudSession } from "@/lib/cloudSession";
import { isMultiOrg } from "@/lib/multiOrg";
import { selectSession } from "@/lib/sessions";
import { parseCloudWorkspaceKey } from "@/types/target";
import { SessionView } from "./SessionView";

/**
 * A selected cloud session (`cloud:<orgId>:<workspaceId>:<sessionId>`) in the
 * same SessionView as a local one. Mounting it never wakes the workspace.
 */
export function CloudSessionHost({ sessionKey, sidebarOpen, onToggleSidebar }: { sessionKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const cloud = useCloudSession(sessionKey);
  const { status } = useAccount();
  const orgId = parseCloudWorkspaceKey(sessionKey)?.orgId ?? null;
  // Every organization live (CS-18): the user left this session's
  // organization, so nothing of it is connected or shown any more.
  const left = !!orgId && isMultiOrg(status) && !(status.organizations ?? []).some((org) => org.id === orgId) && status.identity?.organizationId !== orgId;
  if (left) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="cloud-session-no-access">
        You no longer have access to this organization.
        <Button size="sm" variant="outline" onClick={() => selectSession(null)}>
          Back
        </Button>
      </div>
    );
  }
  if (!cloud) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This cloud session link is not valid.</div>;
  }
  return <SessionView session={cloud.session} cloud={cloud} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />;
}
