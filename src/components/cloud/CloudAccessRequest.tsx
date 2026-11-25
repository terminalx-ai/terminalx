import { useRef, useState } from "react";
import { Lock } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAccount, useAccount } from "@/lib/account";
import { api, type CloudWorkspaceShare } from "@/lib/api";
import { cloudOrgArg, findCloudWorkspace, getCloudCatalog, liveCloudOrgIds, useCloudCatalog, type CloudCatalogState } from "@/lib/cloudCatalog";
import { copyText } from "@/lib/clipboard";
import { privacyEnabled, useDataPrivacy } from "@/lib/dataPrivacy";
import { phase2Ready } from "@/lib/phase2Readiness";

export type AccessRequestTarget = { orgId: string; workspaceId: string };
const roles = { viewer: "Read", driver: "Write", manager: "Admin" } as const;
type Account = ReturnType<typeof getAccount>["status"];
type Shares = { scope: string; state: "loading" | "failed" } | { scope: string; state: "ready"; rows: CloudWorkspaceShare[] };

function requestContext(status: Account, catalog: CloudCatalogState, target: AccessRequestTarget) {
  const { orgId, workspaceId } = target;
  const org = catalog.orgs[orgId];
  const workspace = findCloudWorkspace(catalog, orgId, workspaceId)?.workspace;
  const organization = status.organizations?.find(({ id }) => id === orgId)?.name;
  if (!status.identity || !status.context?.revision || status.identity.email !== catalog.owner
    || catalog.revision !== status.context.revision || !phase2Ready(status, orgId, "workspaceAccessRequest")
    || !liveCloudOrgIds(status).includes(orgId) || org?.source !== "live" || org.error || !organization
    || !workspace || workspace.orgId !== orgId || workspace.accessMode !== "organization" || workspace.deletedAt
    || workspace.state === "destroyed") return null;
  return {
    organization,
    workspace: workspace.name,
    creator: workspace.creator?.userId === workspace.createdBy ? workspace.creator?.displayName?.trim() || null : null,
    scope: JSON.stringify([status.context.account, status.context.scope, status.context.revision, orgId, workspaceId, organization, workspace.name, workspace.createdBy, workspace.creator?.displayName]),
  };
}

export function CloudAccessRequest({ target, fallback, onBack, onRecheck }: {
  target: AccessRequestTarget;
  fallback: React.ReactNode;
  onBack?: () => void;
  onRecheck?: () => void;
}) {
  const { status } = useAccount();
  const catalog = useCloudCatalog();
  const privacy = useDataPrivacy();
  const context = privacy.enabled ? null : requestContext(status, catalog, target);
  return context ? (
    <RequestPane key={context.scope} context={context} target={target} onBack={onBack} onRecheck={onRecheck} />
  ) : fallback;
}

function RequestPane({ context, target, onBack, onRecheck }: {
  context: NonNullable<ReturnType<typeof requestContext>>;
  target: AccessRequestTarget;
  onBack?: () => void;
  onRecheck?: () => void;
}) {
  const { creator, organization, scope, workspace } = context;
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const shareRead = useRef(0);
  const [shares, setShares] = useState<Shares | null>(null);
  const message = `Hi${creator ? ` ${creator}` : ""}, could you share the TerminalX workspace “${workspace}” in ${organization} with me? Thanks!`;
  const current = () => !privacyEnabled() && requestContext(getAccount().status, getCloudCatalog(), target)?.scope === scope;
  const copy = async () => {
    if (!current()) return;
    setCopyState("copying");
    try {
      await copyText(message);
      if (current()) setCopyState("copied");
    } catch {
      if (current()) setCopyState("failed");
    }
  };
  const readShares = async () => {
    if (!current()) return;
    const request = ++shareRead.current;
    setShares({ scope, state: "loading" });
    try {
      const listed = await api.cloudWorkspaceShares(target.workspaceId, cloudOrgArg(target.orgId));
      if (request === shareRead.current && current()) setShares({ scope, state: "ready", rows: listed.shares });
    } catch {
      if (request === shareRead.current && current()) setShares({ scope, state: "failed" });
    }
  };
  const activeShares = shares?.scope === scope ? shares : null;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto p-6 text-center text-xs text-muted-foreground" data-testid="cloud-not-shared" data-kind="not-shared">
      <Lock className="size-4 shrink-0" />
      <p className="text-sm text-foreground">This workspace has not been shared with you</p>
      <p className="max-w-md break-words">Ask {creator || "its creator"} or an admin of {organization} to share it with you.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={() => void copy()} disabled={copyState === "copying"}>
          {copyState === "idle" ? "Request access" : copyState === "copied" ? "Copied" : copyState === "copying" ? "Copying…" : "Copy again"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => void readShares()}>Who has access</Button>
        {onBack && <Button size="sm" variant="ghost" onClick={onBack}>Back to Overview</Button>}
        {onRecheck && <Button size="sm" variant="ghost" onClick={onRecheck}>Check again</Button>}
      </div>
      {copyState !== "idle" && (
        <div className="w-full max-w-md space-y-2">
          <textarea readOnly aria-label="Prepared access request" value={message} rows={3}
            className="w-full resize-y rounded-md border border-hairline bg-background p-2 text-left text-foreground" />
          {copyState === "copied" && <p role="status">Request copied. Send it to {creator || "the creator"} or an admin of {organization}. They can share it from the workspace’s Share menu.</p>}
          {copyState === "failed" && <p role="alert">Couldn’t copy the request. Select and copy the message above.</p>}
        </div>
      )}
      {activeShares && (
        <Dialog open onOpenChange={(open) => { if (!open) { shareRead.current++; setShares(null); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Who has access</DialogTitle>
              <DialogDescription>People explicitly shared on this workspace.</DialogDescription>
            </DialogHeader>
            {activeShares.state === "loading" && <p role="status">Checking access…</p>}
            {activeShares.state === "failed" && <p role="alert">The access list is unavailable.</p>}
            {activeShares.state === "ready" && (activeShares.rows.length ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
                {activeShares.rows.map((row) => <li key={row.userId} className="break-words">{row.name?.trim() || "Organization member"} · {roles[row.role]}</li>)}
              </ul>
            ) : <p>No explicit shares.</p>)}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
