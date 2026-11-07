import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getAccount, refreshAccount, signIn, useAccount } from "@/lib/account";
import { findCloudWorkspace, getCloudCatalog, refreshCloudWorkspaces } from "@/lib/cloudCatalog";
import { copyWorkspaceLink, type WorkspaceLink, type ResolvedWorkspaceLink } from "@/lib/cloudWorkspaceLinks";
import { getSessionStore, selectCloudWorkspace } from "@/lib/sessions";
import { registerShortcut } from "@/lib/hotkeys";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "@/types/target";

/** Retains cold-start links through sign-in. Resolving and selecting read only;
 * a stopped machine still needs the workspace's ordinary Resume action. */
export function CloudWorkspaceLinkHost() {
  const { status } = useAccount();
  const [link, setLink] = useState<WorkspaceLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let request = 0;
    const read = () => {
      const version = ++request;
      void invoke<WorkspaceLink | null>("cloud_workspace_link_pending").then((pending) => {
        if (live && version === request) { setLink(pending); setError(null); }
      }).catch(() => undefined);
    };
    const subscription = listen("cloud_workspace_link_requested", read);
    read();
    return () => { live = false; void subscription.then((unlisten) => unlisten()).catch(() => undefined); };
  }, []);
  useEffect(() => {
    const copy = () => {
      const store = getSessionStore();
      const selected = store.selectedCloudWorkspace ?? store.selectedSessionId;
      const target = selected ? parseCloudWorkspaceKey(selected) : null;
      const item = target ? findCloudWorkspace(getCloudCatalog(), target.orgId, target.workspaceId) : null;
      if (!item?.workspace.webUrl) return false;
      void copyWorkspaceLink(item.workspace).catch(() => setError("Could not copy the workspace link."));
    };
    return registerShortcut("workspace.copyLink", copy);
  }, []);
  const signedIn = status.state === "signed-in";
  const account = status.context?.account;
  useEffect(() => {
    if (!link || !signedIn) return;
    let active = true;
    setError(null);
    const open = async () => {
      await refreshAccount();
      const result = await invoke<ResolvedWorkspaceLink>("cloud_workspace_link_resolve", { link });
      await refreshCloudWorkspaces(result.orgId);
      if (!active || getAccount().status.context?.account !== account) return;
      selectCloudWorkspace(cloudWorkspaceKey(result.orgId, result.workspaceId));
      await invoke("cloud_workspace_link_clear", { link });
      if (active) setLink(null);
    };
    void open().catch(() => { if (active) setError("You don't have access to this workspace, or it could not be reached. Try opening the link again."); });
    return () => { active = false; };
  }, [link, signedIn, account]);
  const close = () => {
    if (link) void invoke("cloud_workspace_link_clear", { link });
    setLink(null); setError(null);
  };
  if (!link && !error) return null;
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}><DialogContent>
    <DialogTitle>Open cloud workspace</DialogTitle>
    <DialogDescription>{error ?? (signedIn ? "Checking workspace access…" : "Sign in to open this workspace.")}</DialogDescription>
    {!signedIn && <Button onClick={() => void signIn().catch(() => setError("Could not start sign-in."))}>Sign in</Button>}
  </DialogContent></Dialog>;
}
