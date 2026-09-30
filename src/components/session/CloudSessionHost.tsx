import { useCloudSession } from "@/lib/cloudSession";
import { SessionView } from "./SessionView";

/**
 * A selected cloud session (`cloud:<orgId>:<workspaceId>:<sessionId>`) in the
 * same SessionView as a local one. Mounting it never wakes the workspace.
 */
export function CloudSessionHost({ sessionKey, sidebarOpen, onToggleSidebar }: { sessionKey: string; sidebarOpen: boolean; onToggleSidebar: () => void }) {
  const cloud = useCloudSession(sessionKey);
  if (!cloud) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">This cloud session link is not valid.</div>;
  }
  return <SessionView session={cloud.session} cloud={cloud} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />;
}
