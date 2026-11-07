import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { Info } from "@/icons";
import type { CloudWorkspaceListItem } from "@/lib/api";
import { useCloudResources, bytesText } from "@/lib/cloudResources";
import { useCloudConnection } from "@/lib/cloudConnections";
import { loadRosterIn, usePeople } from "@/lib/cloudPeople";
import { cloudProviderName } from "@/lib/cloudSession";
import { cloudWorkspaceKey } from "@/types/target";

export function CloudWorkspaceDetailsCard({ item }: { item: CloudWorkspaceListItem }) {
  const w = item.workspace;
  const key = cloudWorkspaceKey(w.orgId, w.id);
  const { resources } = useCloudResources(key, false, true);
  const connection = useCloudConnection(key);
  const name = usePeople(false);
  useEffect(() => { void loadRosterIn(w.orgId).catch(() => {}); }, [w.orgId]);
  const memory = resources?.memory;
  const disk = resources?.storage;
  const cpu = resources?.cpu;
  const fields = [
    ["Repository", w.repositories?.map((repo) => repo.fullName ?? repo.identity).filter(Boolean).join(", ") || "None"],
    ["Creator", w.createdBy ? name(w.createdBy) : "Unavailable"],
    ["Environment version", w.details?.environmentVersion ? `Version ${w.details.environmentVersion}` : w.details?.environmentVersionId ?? "None"],
    ["Provider", cloudProviderName(w.provider)],
    ["Runtime version", connection.runtimeVersion ?? "Unavailable"],
    ["CPU", cpu ? `${cpu.count} logical CPU${cpu.count === 1 ? "" : "s"}` : "Unavailable"],
    ["Host load (1 min)", cpu?.load1 != null ? cpu.load1.toFixed(2) : "Unavailable"],
    ["Memory", memory ? `${bytesText(memory.totalBytes - memory.availableBytes)} used of ${bytesText(memory.totalBytes)}` : "Unavailable"],
    ["Disk", disk ? `${bytesText(disk.totalBytes - disk.availableBytes)} used of ${bytesText(disk.totalBytes)}` : "Unavailable"],
  ];
  return (
    <section aria-label="Workspace details" className="w-80 max-w-[85vw] p-3">
      <h3 className="mb-3 truncate text-sm font-medium">{w.name}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        {fields.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="break-words text-right">{value}</dd></div>)}
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground">{connection.state === "connected" ? "Resources refresh every 10 seconds. Load is the host’s average queued work, not CPU usage percent." : "Live resources are unavailable while disconnected."}</p>
    </section>
  );
}

export function CloudWorkspaceDetails({ item }: { item: CloudWorkspaceListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><button type="button" aria-label="Workspace details" title="Workspace details" className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Info className="size-3.5" /></button></Popover.Trigger>
      <Popover.Portal><Popover.Content align="start" sideOffset={6} collisionPadding={8} className="z-(--z-menu) rounded-lg bg-popover text-popover-foreground shadow-surface hairline">{open && <CloudWorkspaceDetailsCard item={item} />}</Popover.Content></Popover.Portal>
    </Popover.Root>
  );
}
