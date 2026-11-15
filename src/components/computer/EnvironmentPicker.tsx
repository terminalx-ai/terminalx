import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import { computerKey, type ComputerCapability, type ComputerEntry, type ComputerInventory, type ComputerTarget } from "@/types/computer";

export function useComputerInventory(active: boolean) {
  const [inventory, setInventory] = useState<ComputerInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try { const value = await localVmRequest("computer.inventory", {}); if (request === sequence.current) { setInventory(value); setError(null); } }
    catch (error) { if (request === sequence.current) { setInventory(null); setError(errorMessage(error)); } }
  }, []);
  useEffect(() => { if (active) void refresh(); return () => { sequence.current++; }; }, [active, refresh]);
  return { inventory, error, refresh };
}

/** The value includes the generation: a replacement never inherits a selection. */
export function EnvironmentPicker({ entries, value, onChange, capability, disabled = false }: {
  entries: ComputerEntry[]; value: ComputerTarget | null; onChange: (target: ComputerTarget | null) => void;
  capability?: ComputerCapability; disabled?: boolean;
}) {
  const key = value ? computerKey(value) : "";
  const missing = !!value && !entries.some((entry) => computerKey(entry.target) === key);
  return <label className="block space-y-1 text-xs"><span>Environment</span>
    <select className="w-full rounded border border-border bg-background px-2 py-1" value={key} disabled={disabled} onChange={(event) => onChange(entries.find((entry) => computerKey(entry.target) === event.target.value)?.target ?? null)}>
      <option value="">Select an existing environment</option>
      {missing ? <option value={key}>Selected environment unavailable — select again</option> : null}
      {entries.map((entry) => <option key={computerKey(entry.target)} value={computerKey(entry.target)} disabled={!!capability && !entry.capabilities.includes(capability)}>
        {entry.name}{capability && !entry.capabilities.includes(capability) ? " · unsupported for this route" : ""}
      </option>)}
    </select>
  </label>;
}
