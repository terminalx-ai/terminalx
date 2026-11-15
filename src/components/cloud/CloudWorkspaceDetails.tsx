import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { Info } from "@/icons";
import { Button } from "@/components/ui/button";
import type { CloudWorkspaceDetailsResponse, CloudWorkspaceListItem } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { copyText } from "@/lib/clipboard";
import { bytesText, useWorkspaceDetailsResources } from "@/lib/cloudResources";
import { detailsScope, loadWorkspaceDetails, useWorkspaceDetailsAvailable, workspaceInfo } from "@/lib/cloudWorkspaceDetails";
import { cloudWorkspaceKey } from "@/types/target";

export function CloudWorkspaceDetailsCard({ item, initialCopy }: { item: CloudWorkspaceListItem; initialCopy?: "machine" | "info" }) {
  useAccount();
  const scope = detailsScope();
  const w = item.workspace;
  const [loaded, setLoaded] = useState<{ scope: string; result: CloudWorkspaceDetailsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<{ text: string; failed: boolean } | null>(null);
  const resources = useWorkspaceDetailsResources(cloudWorkspaceKey(w.orgId, w.id));
  useEffect(() => {
    let live = true;
    setLoaded(null); setError(null); setCopy(null);
    void loadWorkspaceDetails(item).then((result) => {
      if (live) setLoaded({ scope, result });
    }).catch(() => { if (live) setError("Workspace details are unavailable. Check your active organization and access, then reopen details."); });
    return () => { live = false; };
  }, [w.id, w.orgId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = loaded?.scope === scope && loaded.result.workspace.id === w.id && loaded.result.workspace.orgId === w.orgId ? loaded.result : null;
  const d = result?.details;
  const resourceText = (resource: { totalBytes: number; availableBytes: number } | null | undefined) => resource && resource.totalBytes > 0
    ? `${bytesText(resource.totalBytes - resource.availableBytes)} used of ${bytesText(resource.totalBytes)}` : "Unavailable";
  const fields = d ? [
    ["Repository", d.repositories.map((repo) => [repo.fullName ?? repo.identity ?? "Repository", repo.ref].filter(Boolean).join(" · ")).join(", ") || "None"],
    ["Creator ID", d.createdBy], ["Provider", d.provider], ["Machine ID", d.machineId ?? "Unavailable"],
    ["Environment version", d.environmentVersion ? String(d.environmentVersion.versionNumber) : "Unavailable"],
    ["Toolchain version", d.environmentVersion ? String(d.environmentVersion.toolchainVersion) : "Unavailable"],
    ["Runtime SHA256", d.runtime?.sha256 ?? "Unavailable"],
    ["Runtime installed", d.runtime ? new Date(d.runtime.installedAt).toLocaleString() : "Unavailable"],
    ["Created", new Date(result.workspace.createdAt).toLocaleString()],
    ["CPU", "Unavailable"], ["Memory", resourceText(resources?.memory)], ["Disk", resourceText(resources?.storage)],
    ["Sample time", resources ? new Date(resources.observedAt).toLocaleTimeString() : "Unavailable"],
  ] : [];
  const write = async (text: string) => {
    if (!result || loaded?.scope !== detailsScope()) return;
    const owner = detailsScope();
    try { await copyText(text); if (owner === detailsScope()) setCopy({ text, failed: false }); }
    catch { if (owner === detailsScope()) setCopy({ text, failed: true }); }
  };
  useEffect(() => {
    if (!result || !initialCopy) return;
    const text = initialCopy === "machine" ? result.details.machineId : workspaceInfo(result);
    if (text) void write(text);
    // One copy for each successfully loaded response, never on render.
  }, [result, initialCopy]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-label="Workspace details" className="w-96 max-w-[85vw] p-3">
      <h3 className="mb-3 truncate text-sm font-medium">{w.name}</h3>
      {error ? <p role="alert" className="text-xs">{error}</p> : !d ? <p role="status">Loading details…</p> : <>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          {fields.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}
        </dl>
        <p className="mt-3 text-[11px] text-muted-foreground">Live resources refresh every 10 seconds while connected. Missing or stale readings are unavailable.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!d.machineId} onClick={() => void write(d.machineId!)}>Copy machine ID</Button>
          <Button size="sm" variant="outline" onClick={() => void write(workspaceInfo(result))}>Copy workspace info</Button>
        </div>
        {d.provisioningLog && /^https:\/\//.test(d.provisioningLog.url) && <a className="mt-2 block text-xs underline" href={d.provisioningLog.url} target="_blank" rel="noopener noreferrer">Open provisioning log</a>}
        {copy && <p role="status" className="mt-2 text-xs">{copy.failed ? "Could not copy. Select and copy the text below." : "Copied."}</p>}
        {copy?.failed && <textarea aria-label="Text to copy" readOnly value={copy.text} onFocus={(event) => event.currentTarget.select()} className="mt-2 w-full text-xs" />}
      </>}
    </section>
  );
}

export function CloudWorkspaceDetails({ item }: { item: CloudWorkspaceListItem }) {
  const available = useWorkspaceDetailsAvailable();
  const [open, setOpen] = useState(false);
  if (!available) return null;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" aria-label="Workspace details" title="Workspace details" className="rounded p-1 text-muted-foreground hover:text-foreground"><Info className="size-3.5" /></button></Popover.Trigger>
    <Popover.Portal><Popover.Content align="start" sideOffset={6} collisionPadding={8} className="z-(--z-menu) rounded-lg bg-popover text-popover-foreground shadow-surface hairline">{open && <CloudWorkspaceDetailsCard key={`${item.workspace.orgId}:${item.workspace.id}`} item={item} />}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}
