import { Activity } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/menu";
import { OrganizationDiagnostics } from "@/components/settings/OrganizationDiagnostics";
import { useAccount } from "@/lib/account";
import type { AccountStatus } from "@/lib/api";

/**
 * Cloud diagnostics (PRO-38) where cloud work shows: a cloud project's "…"
 * menu and a cloud session's location chip. The report is the organization's,
 * for its owners and administrators; the server checks the role in that
 * organization, whichever one is the default here.
 */

export type DiagnosticsRequest = { orgId: string; workspaceId?: string | null };

/** Hidden only from someone the account already says is a member there; the server decides for everyone else. */
export function offersCloudDiagnostics(status: AccountStatus, orgId: string): boolean {
  if (status.state !== "signed-in") return false;
  return status.organizations?.find((org) => org.id === orgId)?.role !== "member";
}

export function CloudDiagnosticsMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Activity /> Cloud diagnostics…
    </DropdownMenuItem>
  );
}

export function CloudDiagnosticsDialog({ request, onClose }: { request: DiagnosticsRequest; onClose: () => void }) {
  const { status } = useAccount();
  const org = status.organizations?.find((entry) => entry.id === request.orgId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent width="max-w-[44rem]" className="flex max-h-[85vh] flex-col" data-testid="cloud-diagnostics-dialog">
        <DialogHeader className="mb-3 pr-6">
          <DialogTitle className="truncate">Cloud diagnostics{org ? ` · ${org.name}` : ""}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            For this organization's owners and administrators.{request.workspaceId ? " The workspace you opened this from is highlighted." : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
          <OrganizationDiagnostics
            contextRevision={status.context?.revision ?? ""}
            orgId={request.orgId}
            workspaceId={request.workspaceId ?? null}
            member={org?.role === "member"}
            framed={false}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
