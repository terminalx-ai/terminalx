import { useEffect, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from "@/components/ui/popover";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { ENVIRONMENT_STALE_MS, ENVIRONMENT_TOOLS, environmentReport, type EnvironmentReport } from "@/lib/environmentInfo";

type Result = { client: WorkspaceRpcClient; generation: number; epoch?: string; report: EnvironmentReport; receivedAt: number };

/** Caller supplies an account/organization/workspace identity, changing it on replacement. */
export function EnvironmentInfo({ client, state, scopeKey }: { client: WorkspaceRpcClient; state: WorkspaceConnectionState; scopeKey: string }) {
  return <EnvironmentInfoReport key={scopeKey} client={client} state={state} />;
}

function EnvironmentInfoReport({ client, state }: { client: WorkspaceRpcClient; state: WorkspaceConnectionState }) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const connected = state.state === "connected";
  const manager = connected && state.authority === "manage";
  const readable = !connected || (manager && (!state.you || (state.you.listed !== false && state.you.role !== "none")));
  const supported = connected && readable && state.capabilities.includes("environment/1");
  const epoch = connected ? state.runtimeEpoch : undefined;
  const generation = connected ? state.runtimeGeneration : -1;
  const current = result?.client === client && readable ? result : null;
  const stale = current && (failed || loading || !supported || now - current.report.observedAt >= ENVIRONMENT_STALE_MS || current.generation !== generation || current.epoch !== epoch || now - current.receivedAt >= ENVIRONMENT_STALE_MS);

  useEffect(() => {
    if (!readable) setResult(null);
  }, [readable]);

  useEffect(() => {
    if (!open || !supported) return;
    let active = true;
    let requestId = crypto.randomUUID();
    const cancel = () => {
      if (!active) return;
      active = false;
      void client.call("environment.cancel", { requestId }).catch(() => {});
    };
    setLoading(true);
    setFailed(false);
    const load = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return environmentReport(await client.call<unknown>("environment.report", { requestId })); }
        catch (error) {
          if (attempt || !error || typeof error !== "object" || !("code" in error) || error.code !== "environment_busy") throw error;
          await new Promise((resolve) => setTimeout(resolve, 350));
          if (!active) return null;
          requestId = crypto.randomUUID();
        }
      }
      return null;
    };
    void load().then((report) => {
      if (!active || !report) return;
      const receivedAt = Date.now();
      setResult({ client, generation, epoch, report, receivedAt });
      setNow(receivedAt);
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return cancel;
  }, [open, supported, generation, epoch, client, refresh]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button size="sm" variant="ghost">Environment info</Button></PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} label="Environment info" className="max-h-[70vh] text-sm">
          <p className="mt-1 text-xs text-muted-foreground">Versions reported by this workspace’s runtime.</p>
          <div role="status" className="my-2 text-xs text-muted-foreground">
            {!connected ? "Connect to the running workspace to read its tools." : !manager ? "Only workspace managers can read installed tools." : !readable ? "Workspace access is unavailable." : !supported ? "This runtime does not support environment reports." : loading ? "Reading installed tools…" : failed ? "Could not read installed tools. Try again." : null}
            {stale && <p>Previous report — may be out of date.</p>}
          </div>
          {current && <dl className="space-y-1" aria-label="Installed tools">
            {ENVIRONMENT_TOOLS.map(([id, label]) => {
              const tool = current.report.tools.find((entry) => entry.id === id)!;
              const text = tool.status === "installed" ? tool.version : tool.status === "missing" ? "Not found" : tool.status === "timeout" ? "Timed out" : "Unavailable";
              return <div key={id} className="flex justify-between gap-4"><dt>{label}</dt><dd className="font-mono text-xs">{text}</dd></div>;
            })}
          </dl>}
          {supported && <Button className="mt-3" size="sm" variant="secondary" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>}
          <PopoverClose asChild><Button className="ml-2 mt-3" size="sm" variant="ghost">Close</Button></PopoverClose>
      </PopoverContent>
    </Popover>
  );
}
