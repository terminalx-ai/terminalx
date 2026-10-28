import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import { computerKey, type ComputerContext, type ComputerSelection as Selection, type ComputerTarget } from "@/types/computer";
import { EnvironmentPicker, useComputerInventory } from "./EnvironmentPicker";
import { LinuxComputerSetup } from "./LinuxComputerSetup";

export function ComputerSelection({ context, active, children }: {
  context: ComputerContext; active: boolean; children: (target: ComputerTarget | null) => ReactNode;
}) {
  const { inventory, error: inventoryError, refresh } = useComputerInventory(active);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [target, setTarget] = useState<ComputerTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [setupTarget, setSetupTarget] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void localVmRequest("computer.selection", context).then((value) => {
      if (current) { setSelection(value); setTarget(value.target); setLoaded(true); }
    }).catch((error) => { if (current) setError(errorMessage(error)); });
    return () => { current = false; };
  }, [context.sessionId, context.tabId, context.conversation]);
  const entry = inventory?.entries.find((entry) => target && computerKey(entry.target) === computerKey(target));
  async function attach(next: ComputerTarget | null) {
    if (busy) return;
    setBusy(true); setError(null);
    try { setSelection(await localVmRequest("computer.select", { ...context, target: next })); setLoaded(true); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <div className="flex h-full flex-col">
    <div className="space-y-2 border-b border-hairline p-3 text-xs">
      <EnvironmentPicker entries={inventory?.entries ?? []} value={target} disabled={busy} onChange={setTarget} />
      <p>Linux: attached desktop tools, or selected tasks after guest runtime setup. macOS: selected guest tasks from the conversation. The agent's shell and project files stay where they are.</p>
      <p>{!loaded ? "Desktop attachment has not been read." : selection?.target ? `This tab's desktop attachment: ${selection.target.kind === "linuxContainer" ? `${selection.target.runtime} · ${selection.target.id.slice(0, 12)}` : "unsupported target"}.` : "No desktop attachment is selected for this tab."} Changes require this tab's agent to be stopped.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={busy || !entry?.capabilities.includes("attachedDesktop") || entry.state !== "running"} onClick={() => void attach(target)}>Attach desktop tools to this tab</Button>
        <Button size="xs" variant="outline" disabled={busy || (!selection?.target && !error)} onClick={() => void attach(null)}>Clear attachment</Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void refresh()}>Refresh environments</Button>
        {target && target.kind !== "macosGuest" ? <Button size="xs" variant="outline" onClick={() => setSetupTarget(setupTarget === computerKey(target) ? null : computerKey(target))}>Linux setup and ownership</Button> : null}
      </div>
      {target && target.kind !== "macosGuest" && setupTarget === computerKey(target) ? <LinuxComputerSetup key={computerKey(target)} target={target} /> : null}
      {target?.kind === "macosGuest" ? <p>Use Local VM tasks in the conversation to check this macOS guest and submit a selected task. Attached macOS desktop tools are not available on this route.</p> : null}
      {error || inventoryError ? <p role="alert" className="text-destructive">{error || inventoryError}</p> : null}
      {inventory?.notices.map((notice) => <p key={notice} className="text-muted-foreground">{notice}</p>)}
    </div>
    <div className="min-h-0 flex-1">{!loaded || (target && target.kind !== "linuxContainer") ? null : target && !entry ? <p className="p-3 text-xs">Selected environment unavailable. Refresh and select again; no other desktop is shown.</p> : children(target)}</div>
  </div>;
}
