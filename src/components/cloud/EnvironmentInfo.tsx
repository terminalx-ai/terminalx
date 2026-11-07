import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { getAccount, subscribeAccount, useAccount } from "@/lib/account";
import { ENVIRONMENT_STALE_MS, ENVIRONMENT_TOOLS, environmentReport, type EnvironmentReport } from "@/lib/environmentInfo";

type Result = { client: WorkspaceRpcClient; account: string; generation: number; report: EnvironmentReport; receivedAt: number };

export function EnvironmentInfo({ client, state, organizationId }: { client: WorkspaceRpcClient; state: WorkspaceConnectionState; organizationId: string }) {
  const { status } = useAccount();
  const offered = status.state === "signed-in" && status.organizations?.find((org) => org.id === organizationId)?.cloud?.flags?.["cloud.environment-info.v1"] === true;
  return offered ? <EnvironmentInfoReport key={JSON.stringify(status.context ?? null)} client={client} state={state} /> : null;
}

function EnvironmentInfoReport({ client, state }: { client: WorkspaceRpcClient; state: WorkspaceConnectionState }) {
  const { status } = useAccount();
  const account = JSON.stringify(status.context ?? null);
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const connected = state.state === "connected";
  const supported = connected && state.capabilities.includes("environment/1");
  const generation = connected ? state.runtimeGeneration : -1;
  const current = result?.client === client && result.account === account ? result : null;
  const stale = current && (failed || loading || !connected || now - current.report.observedAt >= ENVIRONMENT_STALE_MS || current.generation !== generation || now - current.receivedAt >= ENVIRONMENT_STALE_MS);

  useEffect(() => {
    if (!open || !supported) return;
    let active = true;
    const requestId = crypto.randomUUID();
    const cancel = () => {
      if (!active) return;
      active = false;
      void client.call("environment.cancel", { requestId }).catch(() => {});
    };
    const unsubscribe = subscribeAccount(() => {
      if (JSON.stringify(getAccount().status.context ?? null) !== account) cancel();
    });
    setLoading(true);
    setFailed(false);
    void client.call<unknown>("environment.report", { requestId }).then(environmentReport).then((report) => {
      if (!active || JSON.stringify(getAccount().status.context ?? null) !== account) return;
      const receivedAt = Date.now();
      setResult({ client, account, generation, report, receivedAt });
      setNow(receivedAt);
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { unsubscribe(); cancel(); };
  }, [open, supported, generation, client, account, refresh]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  return (
    <Popover.Root modal={false} open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><Button size="sm" variant="ghost">Environment info</Button></Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} aria-label="Environment info" className="z-50 w-80 rounded-lg border border-hairline bg-popover p-3 text-sm text-popover-foreground shadow-lg">
          <h2 className="font-medium">Environment info</h2>
          <p className="mt-1 text-xs text-muted-foreground">Versions reported by this workspace’s runtime.</p>
          <div role="status" className="my-2 text-xs text-muted-foreground">
            {!connected ? "Connect to the running workspace to read its tools." : !supported ? "This runtime does not support environment reports." : loading ? "Reading installed tools…" : failed ? "Could not read installed tools. Try again." : null}
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
          <Popover.Close asChild><Button className="ml-2 mt-3" size="sm" variant="ghost">Close</Button></Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
