import { AlertTriangle } from "lucide-react";
import { memoryNoticeText, storageNotice, useCloudResources } from "@/lib/cloudResources";
import { cn } from "@/lib/cn";

/**
 * Says when the machine under a connected cloud workspace is running out of
 * disk, or of memory while an agent turn runs (PRO-33), where the session or
 * the workspace is shown. It reads over the connection already held and
 * shows nothing for a workspace that is not connected, so looking at a
 * stopped workspace never wakes it. `turn`: an agent turn is running here.
 */
export function CloudResourceNotice({ workspaceKey, turn = false, manage = false }: { workspaceKey: string | null; turn?: boolean; /** This person has a terminal in the workspace to act with. */ manage?: boolean }) {
  const { resources, memoryWarning } = useCloudResources(workspaceKey, turn);
  const storage = storageNotice(resources?.storage ?? null, manage);
  const memory = memoryWarning && resources?.memory ? memoryNoticeText(resources.memory, manage) : null;
  if (!storage && !memory) return null;
  return (
    <>
      {storage && (
        <Notice testId="cloud-storage-notice" level={storage.level} alert={storage.level === "full"}>
          {storage.text}
        </Notice>
      )}
      {memory && (
        <Notice testId="cloud-memory-notice" level="low" alert={false}>
          {memory}
        </Notice>
      )}
    </>
  );
}

function Notice({ testId, level, alert, children }: { testId: string; level: "low" | "full"; alert: boolean; children: string }) {
  return (
    <div
      className={cn("flex shrink-0 items-start gap-2 border-b border-hairline bg-well px-4 py-1.5 text-xs", alert ? "text-destructive" : "text-muted-foreground")}
      role={alert ? "alert" : "status"}
      data-testid={testId}
      data-level={level}
    >
      <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", !alert && "text-warning")} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}
