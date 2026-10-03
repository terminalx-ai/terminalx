import { useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CloudCreateWorkspace } from "./CloudCreateWorkspace";
import { useAccount } from "@/lib/account";
import { applyCloudSnapshot, refreshCloudCatalog } from "@/lib/cloudCatalog";
import { selectCloudWorkspace } from "@/lib/sessions";
import { cloudWorkspaceKey } from "@/types/target";

let open = false;
const listeners = new Set<() => void>();

/**
 * Open (or close) the full new-workspace form: several repositories with
 * their base branches, the provider, and who can see it. It works in the
 * default organization, like the calls behind it. A project's `+` is the
 * quicker way to one more session; this is the explicit, priced step.
 */
export function openNewCloudWorkspace(next = true) {
  open = next;
  for (const listener of [...listeners]) listener();
}

/** Mounted once (AppShell): the dialog for `openNewCloudWorkspace`. */
export function NewCloudWorkspaceDialogHost() {
  const shown = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => false,
  );
  return shown ? <NewCloudWorkspaceDialog /> : null;
}

function NewCloudWorkspaceDialog() {
  const { status } = useAccount();
  if (status.state !== "signed-in") return null;
  const scope = status.context?.scope ?? "signed-in";
  const refresh = () => void refreshCloudCatalog();
  const close = () => {
    openNewCloudWorkspace(false);
    refresh();
  };
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent width="max-w-[40rem]" className="max-h-[85dvh] overflow-y-auto" data-testid="cloud-new-workspace-dialog">
        <DialogHeader>
          <DialogTitle>New cloud workspace</DialogTitle>
          <DialogDescription>A new machine in {status.identity?.organization ?? "your default organization"}, with its price shown before anything is created.</DialogDescription>
        </DialogHeader>
        <CloudCreateWorkspace
          key={scope}
          organizationId={scope}
          onChanged={refresh}
          onProgress={(snapshot) => applyCloudSnapshot(snapshot)}
          onOpen={(item) => {
            close();
            selectCloudWorkspace(cloudWorkspaceKey(item.workspace.orgId, item.workspace.id));
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
