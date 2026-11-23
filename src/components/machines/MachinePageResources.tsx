import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { resourceMeters, resourcesSummary, useMachineResources } from "@/lib/machineResources";
import { pageCard, pageHeading } from "./MachinePageAgents";

/**
 * Resources on a machine's page (21.10): "<n> cores · updated just now",
 * then CPU, Memory and Disk with a bar each, read every 5 seconds while the
 * page is open. A part the machine does not report (CPU from an older
 * runtime) is left out.
 */
export function MachinePageResources({ name, client, connected }: { name: string; client: WorkspaceRpcClient | null; connected: boolean }) {
  const { resources, readAt, unsupported, error } = useMachineResources(client, connected);
  const meters = resources ? resourceMeters(resources) : [];
  let body;
  if (resources && meters.length) {
    body = (
      <div className="grid gap-x-6 gap-y-3 px-3.5 py-3 sm:grid-cols-3" data-testid="machine-resource-meters">
        {meters.map((meter) => (
          <div key={meter.id} className="grid min-w-0 gap-1.5" data-testid="machine-resource" data-resource={meter.id}>
            <div className="flex min-w-0 items-baseline justify-between gap-2 text-[12.5px]">
              <span className="text-muted-foreground">{meter.label}</span>
              <span className="truncate tabular-nums text-foreground">{meter.value}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-well" role="meter" aria-label={meter.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.fraction * 100)}>
              <div className="h-full rounded-full bg-muted-foreground/70" style={{ width: `${meter.fraction * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    const text = !connected
      ? `Shown once ${name} is connected.`
      : unsupported || (resources && !meters.length)
        ? `${name} runs a TerminalX that does not report its resources.`
        : error
          ? `Could not read its resources: ${error}`
          : "Reading its resources…";
    body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{text}</p>;
  }
  return (
    <section className="grid gap-2.5" data-testid="machine-resources" aria-label="Resources">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={pageHeading}>Resources</h3>
        {resources && readAt !== null && (
          <span className="truncate text-[12px] text-faint" data-testid="machine-resources-summary">
            {resourcesSummary(resources, readAt)}
          </span>
        )}
      </div>
      <div className={pageCard}>{body}</div>
    </section>
  );
}
