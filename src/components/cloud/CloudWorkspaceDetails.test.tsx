import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";

const connections = vi.hoisted(() => ({ client: {} as object | null, listeners: new Set<() => void>() }));
vi.mock("@/lib/cloudConnections", () => ({
  connectedCloudClient: () => connections.client,
  subscribeCloudConnections: (fn: () => void) => { connections.listeners.add(fn); return () => connections.listeners.delete(fn); },
  useCloudConnection: () => ({ state: connections.client ? "connected" : "suspended", runtimeVersion: "0.2.25" }),
}));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => (id: string) => id, loadRosterIn: () => Promise.resolve([]) }));
vi.mock("@/lib/cloudSession", () => ({ cloudProviderName: () => "Boat" }));
import { CloudWorkspaceDetailsCard } from "./CloudWorkspaceDetails";
import { setCloudResourcesReader } from "@/lib/cloudResources";

const item: CloudWorkspaceListItem = {
  workspace: { id: "ws", orgId: "org", name: "Website", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null, createdBy: "owner", repositories: [{ identity: "repo", fullName: "team/site", cloneUrl: null }], details: { machineId: "machine", environmentVersionId: "env", environmentVersion: 3 } },
  latestOperation: null,
};
const gib = 1024 ** 3;
const resource = { v: 1, cpu: { count: 4, load1: 1.25 }, memory: { totalBytes: 8 * gib, availableBytes: 6 * gib }, storage: { totalBytes: 40 * gib, availableBytes: 30 * gib, totalInodes: 100, availableInodes: 80 }, observedAt: 1 };
beforeEach(() => { vi.useFakeTimers(); connections.client = {}; });
afterEach(async () => { cleanup(); await vi.advanceTimersByTimeAsync(0); setCloudResourcesReader(null); vi.useRealTimers(); });

it("shows normal resource values and metadata, refreshes every ten seconds, and releases its timer", async () => {
  const read = vi.fn().mockResolvedValue(resource);
  setCloudResourcesReader(read);
  const view = render(<CloudWorkspaceDetailsCard item={item} />);
  await act(async () => {});
  for (const value of ["team/site", "owner", "Version 3", "Boat", "0.2.25", "4 logical CPUs", "1.25", "2.0 GB used of 8.0 GB", "10 GB used of 40 GB"]) expect(screen.getByText(value)).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(9999));
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ ...resource, cpu: { count: 4, load1: 2.75 } });
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByText("2.75")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not sample a stopped workspace and drops resource figures on disconnect", async () => {
  const read = vi.fn().mockResolvedValue(resource);
  setCloudResourcesReader(read);
  connections.client = null;
  render(<CloudWorkspaceDetailsCard item={item} />);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(read).not.toHaveBeenCalled();
  expect(screen.getByText(/unavailable while disconnected/)).toBeTruthy();
  await act(async () => { connections.client = {}; connections.listeners.forEach((fn) => fn()); });
  expect(screen.getByText("4 logical CPUs")).toBeTruthy();
  await act(async () => { connections.client = null; connections.listeners.forEach((fn) => fn()); });
  expect(screen.queryByText("4 logical CPUs")).toBeNull();
});

it("handles an older runtime with no CPU report", async () => {
  setCloudResourcesReader(vi.fn().mockResolvedValue({ ...resource, cpu: undefined }));
  render(<CloudWorkspaceDetailsCard item={item} />);
  await act(async () => {});
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  expect(screen.getByText("2.0 GB used of 8.0 GB")).toBeTruthy();
});
