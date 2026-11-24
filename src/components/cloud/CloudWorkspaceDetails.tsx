import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Popover } from "radix-ui";
import { Info, Loader2, RotateCcw } from "@/icons";
import { Button } from "@/components/ui/button";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { useAccount } from "@/lib/account";
import { copyText } from "@/lib/clipboard";
import { bytesText, useWorkspaceDetailsResources } from "@/lib/cloudResources";
import { type CloudWorkspaceDetailsResponse, canRestartWorkspace, detailsScope, loadWorkspaceDetails, provisioningLogUrl, useWorkspaceDetailsAvailable, workspaceInfo, workspaceRestarting } from "@/lib/cloudWorkspaceDetails";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { OwnerProfile } from "@/components/dashboard/TeamOverview";
import { cloudWorkspaceKey } from "@/types/target";
import { cloudProviderLabel } from "@/lib/cloudProviders";
import { deriveCloudActivity } from "@/lib/cloudRowState";
import { WorkspaceRestartDialog } from "./WorkspaceActionsRestart";

type CopyField = "machine" | "info";

function DetailsRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-3 px-3 py-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-words">{children}</dd>
  </div>;
}

function ResourceReading({ text, ratio }: { text: string; ratio?: number }) {
  return <>
    {text}
    {ratio !== undefined && <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-veil-raised">
      <div className="h-full rounded-full bg-foreground/60" style={{ width: `${ratio * 100}%` }} />
    </div>}
  </>;
}

function ByteReading({ resource }: { resource?: { totalBytes: number; availableBytes: number } | null }) {
  if (!resource || !Number.isFinite(resource.totalBytes) || !Number.isFinite(resource.availableBytes)
    || resource.totalBytes <= 0 || resource.availableBytes < 0 || resource.availableBytes > resource.totalBytes) return "Unavailable";
  const used = resource.totalBytes - resource.availableBytes;
  return <ResourceReading text={`${bytesText(used)} used of ${bytesText(resource.totalBytes)}`} ratio={used / resource.totalBytes} />;
}

function CpuReading({ cpu }: { cpu?: { cores: number; usage: number | null } | null }) {
  if (!cpu || !Number.isInteger(cpu.cores) || cpu.cores < 1) return "Unavailable";
  const cores = `${cpu.cores} ${cpu.cores === 1 ? "core" : "cores"}`;
  const usage = cpu.usage;
  if (typeof usage !== "number" || !Number.isFinite(usage) || usage < 0 || usage > 1) return `${cores} · Usage unavailable`;
  return <ResourceReading text={`${cores} · ${Math.round(usage * 100)}% used`} ratio={usage} />;
}

export function CloudWorkspaceDetailsCard({ item, initialCopy, onInitialCopy, onRestart }: {
  item: CloudWorkspaceListItem;
  initialCopy?: CopyField;
  onInitialCopy?: (message: string) => void;
  onRestart?: () => void;
}) {
  useAccount();
  const scope = detailsScope();
  const [owner] = useState(detailsScope);
  const w = item.workspace;
  const catalog = useCloudCatalog();
  const org = catalog.orgs[w.orgId];
  const liveItem = owner === scope && org?.source === "live" && !org.error ? org.workspaces.find((row) => row.workspace.id === w.id) : undefined;
  const current = liveItem ?? (org?.source === "live" && !org.error ? null : item);
  const currentOwner = liveItem?.workspace;
  const [loaded, setLoaded] = useState<{ scope: string; result: CloudWorkspaceDetailsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logError, setLogError] = useState(false);
  const [copy, setCopy] = useState<{ text: string; message: string; failed: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    setLoaded(null); setError(null); setCopy(null); setLogError(false);
    if (owner !== scope) { setError("The account changed. Reopen workspace details in the current account."); return; }
    void loadWorkspaceDetails(item).then((result) => {
      if (live) setLoaded({ scope, result });
    }).catch(() => { if (live) setError("Workspace details are unavailable. Check your active organization and access, then reopen details."); });
    return () => { live = false; };
  }, [w.id, w.orgId, scope, owner]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = loaded?.scope === scope && loaded.result.workspace.id === w.id && loaded.result.workspace.orgId === w.orgId ? loaded.result : null;
  const currentResult = useRef(result);
  currentResult.current = result;
  useEffect(() => () => { currentResult.current = null; }, []);
  const d = result?.details;
  const resources = useWorkspaceDetailsResources(result ? cloudWorkspaceKey(w.orgId, w.id) : null);
  const logUrl = d && provisioningLogUrl(d);
  const openLog = async () => {
    if (!logUrl || currentResult.current !== result || scope !== detailsScope()) return;
    try { await openUrl(logUrl); }
    catch { if (currentResult.current === result && scope === detailsScope()) setLogError(true); }
  };
  const write = async (field: CopyField, initial = false) => {
    if (!result || loaded?.scope !== detailsScope()) return;
    const text = field === "machine" ? result.details.machineId : workspaceInfo(result);
    if (!text) {
      if (initial) setCopy({ text: "", message: "Machine ID is unavailable for this workspace.", failed: true });
      return;
    }
    const message = field === "machine" ? "Copied machine ID" : "Copied workspace info";
    try {
      await copyText(text);
      if (scope !== detailsScope() || currentResult.current !== result) return;
      if (initial && onInitialCopy) onInitialCopy(message);
      else setCopy({ text, message, failed: false });
    } catch {
      if (scope === detailsScope() && currentResult.current === result) {
        setCopy({ text, message: "Could not copy. Select and copy the text below.", failed: true });
      }
    }
  };
  useEffect(() => {
    if (result && initialCopy) void write(initialCopy, true);
    // One copy for each successfully loaded response.
  }, [result, initialCopy]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section aria-label="Workspace details" className="min-w-0 space-y-3 text-xs">
      <h3 className="truncate text-sm font-medium">{w.name}</h3>
      {error ? <p role="alert">{error}</p> : !d ? <p role="status">Loading details…</p> : <>
        <dl className="divide-y divide-hairline rounded-lg border border-hairline">
          <DetailsRow label="Repository">{d.repositories.map((repo) => [repo.fullName ?? repo.identity ?? "Repository", repo.ref].filter(Boolean).join(" · ")).join(", ") || "None"}</DetailsRow>
          <DetailsRow label="Owner">{currentOwner?.createdBy
            ? <OwnerProfile orgId={w.orgId} userId={currentOwner.createdBy} name={currentOwner.creator?.displayName ?? "Owner"} />
            : "Unavailable"}</DetailsRow>
          <DetailsRow label="Environment">{d.environmentVersion ? `Version ${d.environmentVersion.versionNumber} · Toolchain ${d.environmentVersion.toolchainVersion}` : "Unavailable"}</DetailsRow>
          <DetailsRow label="Provider">{cloudProviderLabel(d.provider)}</DetailsRow>
          <DetailsRow label="Created">{new Date(result.workspace.createdAt).toLocaleString()}</DetailsRow>
          {result.workspace.checkout && <DetailsRow label="Setup">{result.workspace.checkout.state === "ready" ? "Checkout ready" : "Checkout failed"}</DetailsRow>}
        </dl>
        <section aria-label="Workspace health" className="rounded-lg border border-hairline">
          <dl className="divide-y divide-hairline">
            <DetailsRow label="Status">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{!current ? "Unavailable" : workspaceRestarting(current) ? "Restarting" : deriveCloudActivity(current).label}</span>
                {onRestart && current && canRestartWorkspace(current) && <Button size="xs" variant="outline" onClick={onRestart}><RotateCcw /> Restart</Button>}
              </div>
            </DetailsRow>
            <DetailsRow label="CPU"><CpuReading cpu={resources?.cpu} /></DetailsRow>
            <DetailsRow label="Memory"><ByteReading resource={resources?.memory} /></DetailsRow>
            <DetailsRow label="Disk"><ByteReading resource={resources?.storage} /></DetailsRow>
          </dl>
          <p className="border-t border-hairline px-3 py-2 text-[11px] text-muted-foreground">
            {resources ? `Sampled at ${new Date(resources.observedAt).toLocaleTimeString()} · Refreshes every 10 seconds` : "Live resources are unavailable"}
          </p>
        </section>
        <dl className="divide-y divide-hairline rounded-lg border border-hairline">
          <DetailsRow label="Machine ID"><span className="font-mono">{d.machineId ?? "Unavailable"}</span></DetailsRow>
          <DetailsRow label="Runtime SHA256"><span className="break-all font-mono">{d.runtime?.sha256 ?? "Unavailable"}</span></DetailsRow>
          <DetailsRow label="Runtime installed">{d.runtime ? new Date(d.runtime.installedAt).toLocaleString() : "Unavailable"}</DetailsRow>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!d.machineId} onClick={() => void write("machine")}>Copy machine ID</Button>
          <Button size="sm" variant="outline" onClick={() => void write("info")}>Copy workspace info</Button>
          {logUrl && <Button size="sm" variant="link" onClick={() => void openLog()}>Open provisioning log</Button>}
        </div>
        {logError && <p role="alert">Could not open the provisioning log. Try again.</p>}
        {copy && <p role="status">{copy.message}</p>}
        {copy?.failed && copy.text && <textarea aria-label="Text to copy" readOnly value={copy.text} onFocus={(event) => event.currentTarget.select()} className="w-full text-xs" />}
      </>}
    </section>
  );
}

export function CloudWorkspaceDetails({ item }: { item: CloudWorkspaceListItem }) {
  const available = useWorkspaceDetailsAvailable(item.workspace.orgId);
  if (!available) return null;
  return <WorkspaceDetailsControl key={JSON.stringify([detailsScope(), item.workspace.orgId, item.workspace.id])} item={item} />;
}

function WorkspaceDetailsControl({ item }: { item: CloudWorkspaceListItem }) {
  const [open, setOpen] = useState(false);
  const [restart, setRestart] = useState(false);
  return <>
    {workspaceRestarting(item) && <span role="status" title="TerminalX will try to reattach open tabs when the workspace is back." data-testid="cloud-workspace-restarting"
      className="flex shrink-0 items-center gap-1 rounded-full bg-veil-raised px-1.5 py-0.5 text-[11px] text-muted-foreground">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Restarting
    </span>}
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" aria-label="Workspace details" title="Workspace details" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"><Info className="size-3.5" /></button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content aria-label="Workspace details" align="start" sideOffset={6} collisionPadding={8}
          className="z-(--z-menu) max-h-(--radix-popover-content-available-height) w-96 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg bg-popover p-3 text-popover-foreground shadow-surface hairline">
          {open && <CloudWorkspaceDetailsCard item={item} onRestart={() => { setOpen(false); setRestart(true); }} />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {restart && <WorkspaceRestartDialog item={item} onClose={() => setRestart(false)} />}
  </>;
}
