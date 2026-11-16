import { useEffect, useState } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { runtimeResources, type RuntimeResources } from "@terminalx/portable/workspaceGit";
import { errorMessage } from "@/lib/api";

/**
 * A machine's processor, memory and disk on its page (PRO-350, 21.10):
 * `lifecycle.resources` every 5 seconds while the page is open, over the
 * connection the machine already has. Nothing is asked while it is not
 * connected; a reading from before a drop is kept and its age shown.
 */
export const MACHINE_RESOURCES_MS = 5_000;

const GB = 1_000_000_000;

export interface MachineResourcesState {
  resources: RuntimeResources | null;
  /** When the last reading arrived on this Mac. */
  readAt: number | null;
  /** The runtime does not report resources (an older one). */
  unsupported: boolean;
  error: string | null;
}

const NONE: MachineResourcesState = { resources: null, readAt: null, unsupported: false, error: null };

/** Poll while `client` is connected and the page shows. */
export function useMachineResources(client: WorkspaceRpcClient | null, connected: boolean, intervalMs = MACHINE_RESOURCES_MS): MachineResourcesState {
  const [state, setState] = useState<MachineResourcesState>(NONE);
  useEffect(() => {
    setState(NONE);
  }, [client]);
  useEffect(() => {
    if (!client || !connected) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const resources = await runtimeResources(client);
        if (!live) return;
        if (!resources) {
          setState({ ...NONE, unsupported: true });
          return; // An older runtime: asking again would only be refused again.
        }
        setState({ resources, readAt: Date.now(), unsupported: false, error: null });
      } catch (error) {
        if (live) setState((now) => ({ ...now, error: errorMessage(error) }));
      }
      if (live) timer = setTimeout(() => void read(), intervalMs);
    };
    void read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, connected, intervalMs]);
  return state;
}

/** "9.2 GB", "16 GB", "212 GB": decimal gigabytes, as a disk or a machine's spec sheet says them. */
export function gbText(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  const one = Math.round(gb * 10) / 10;
  return `${Number.isInteger(one) ? one.toFixed(0) : one.toFixed(1)} GB`;
}

/** "updated just now", "updated 40 s ago", "updated 3 min ago". */
export function updatedText(readAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - readAt) / 1000));
  if (seconds < 10) return "updated just now";
  if (seconds < 60) return `updated ${seconds} s ago`;
  return `updated ${Math.round(seconds / 60)} min ago`;
}

/** The line beside Resources: "8 cores · updated just now". */
export function resourcesSummary(resources: RuntimeResources, readAt: number, now = Date.now()): string {
  const cores = resources.cpu?.cores;
  return [cores ? `${cores} ${cores === 1 ? "core" : "cores"}` : null, updatedText(readAt, now)].filter(Boolean).join(" · ");
}

export interface ResourceMeter {
  id: "cpu" | "memory" | "disk";
  label: string;
  value: string;
  /** How full the bar is, 0 to 1. */
  fraction: number;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * CPU %, Memory "x of y GB" and Disk "z GB free", each with its bar. A part
 * the runtime did not report is left out; CPU shows "…" until a second
 * reading has something to compare with.
 */
export function resourceMeters(resources: RuntimeResources): ResourceMeter[] {
  const meters: ResourceMeter[] = [];
  if (resources.cpu) {
    const usage = resources.cpu.usage;
    meters.push({ id: "cpu", label: "CPU", value: usage === null ? "…" : `${Math.round(clamp(usage) * 100)}%`, fraction: usage === null ? 0 : clamp(usage) });
  }
  const memory = resources.memory;
  if (memory && memory.totalBytes > 0) {
    const used = Math.max(0, memory.totalBytes - memory.availableBytes);
    meters.push({ id: "memory", label: "Memory", value: `${gbText(used).replace(/ GB$/, "")} of ${gbText(memory.totalBytes)}`, fraction: clamp(used / memory.totalBytes) });
  }
  const storage = resources.storage;
  if (storage && storage.totalBytes > 0) {
    meters.push({ id: "disk", label: "Disk", value: `${gbText(storage.availableBytes)} free`, fraction: clamp((storage.totalBytes - storage.availableBytes) / storage.totalBytes) });
  }
  return meters;
}
