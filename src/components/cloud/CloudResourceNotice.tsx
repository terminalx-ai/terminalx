import { AlertTriangle } from "lucide-react";
import { storageNotice, useCloudResources } from "@/lib/cloudResources";
import { cn } from "@/lib/cn";

/**
 * Says when the machine under a connected cloud workspace is running out of
 * disk (PRO-33), where the session or the workspace is shown. It reads over
 * the connection already held and shows nothing for a workspace that is not
 * connected, so looking at a stopped workspace never wakes it.
 */
export function CloudResourceNotice({ workspaceKey }: { workspaceKey: string | null }) {
  const resources = useCloudResources(workspaceKey);
  const storage = storageNotice(resources?.storage ?? null);
  if (!storage) return null;
  return (
    <div
      className={cn("flex shrink-0 items-start gap-2 border-b border-hairline bg-well px-4 py-1.5 text-xs", storage.level === "full" ? "text-destructive" : "text-muted-foreground")}
      role={storage.level === "full" ? "alert" : "status"}
      data-testid="cloud-storage-notice"
      data-level={storage.level}
    >
      <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", storage.level === "low" && "text-warning")} />
      <span className="min-w-0">{storage.text}</span>
    </div>
  );
}
