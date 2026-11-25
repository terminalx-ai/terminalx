import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type AgentLogin, type AgentLoginAffectedWorkspaces } from "@/lib/api";

type Preview = { kind: "loading" } | { kind: "unavailable" } | { kind: "ready"; impact: AgentLoginAffectedWorkspaces };

export function DisconnectCloudLoginDialog({ login, agent, organization, organizationId, contextRevision, busy, onClose, onConfirm }: {
  login: AgentLogin;
  agent: string;
  organization: string;
  organizationId: string;
  contextRevision: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const submitted = useRef(false);
  const { provider, fingerprint } = login;
  useEffect(() => {
    let current = true;
    void api.cloudAgentLoginAffectedWorkspaces(provider, contextRevision, organizationId).then(
      (impact) => { if (current) setPreview({ kind: "ready", impact }); },
      () => { if (current) setPreview({ kind: "unavailable" }); },
    );
    return () => { current = false; };
  }, [contextRevision, organizationId, provider]);
  useEffect(() => { if (!busy) submitted.current = false; }, [busy]);

  const loading = preview.kind === "loading";
  const impact = preview.kind === "ready" ? preview.impact : null;
  const shortFingerprint = fingerprint.replace(/^sha256:/, "").slice(0, 8);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy && !submitted.current) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Disconnect API key?</DialogTitle>
          <DialogDescription>Remove the {agent} key from cloud logins for {organization}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {shortFingerprint && <p className="text-muted-foreground">Key fingerprint <code>{shortFingerprint}…</code></p>}
          {loading && <p role="status">Checking which running workspaces use this key…</p>}
          {preview.kind === "unavailable" && <p role="alert">Couldn’t check which running workspaces use this key. You can still disconnect it.</p>}
          {impact && impact.count > 0 && (
            <div>
              <p>{impact.count === 1 ? "1 running workspace uses this key." : `${impact.count}${impact.hasMore ? "+" : ""} running workspaces use this key.`}</p>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5">
                {impact.workspaces.map(({ id, name }) => <li key={id} className="break-words">{name}</li>)}
              </ul>
            </div>
          )}
          {impact?.hasHidden && <p>Other running workspaces you can’t view also use this key.</p>}
          <p className="text-muted-foreground">Running tabs can keep using access already issued until it expires. This removes the cloud login. Keys already saved in this Mac’s Keychain stay there.</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy || loading} onClick={() => {
            if (submitted.current) return;
            submitted.current = true;
            onConfirm();
          }}>
            {busy && <Loader2 className="animate-spin" />}
            Disconnect key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
