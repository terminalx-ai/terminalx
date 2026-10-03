import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeResources } from "./cloudResources";

const mocks = vi.hoisted(() => ({ client: null as object | null, listeners: new Set<() => void>() }));

vi.mock("@/lib/cloudConnections", () => ({
  connectedCloudClient: () => mocks.client,
  subscribeCloudConnections: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));

const { bytesText, SAMPLE_MS, setCloudResourcesReader, storageLevel, storageNotice } = await import("./cloudResources");
const { CloudResourceNotice } = await import("@/components/cloud/CloudResourceNotice");

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KEY = "cloud:org-1:ws-1";
const disk = (availableBytes: number, fields: Partial<NonNullable<RuntimeResources["storage"]>> = {}) => ({ totalBytes: 40 * GIB, availableBytes, totalInodes: 1_000_000, availableInodes: 500_000, ...fields });
const reading = (storage: RuntimeResources["storage"]): RuntimeResources => ({ v: 1, memory: null, storage, observedAt: 1 });
const connect = (client: object | null) => {
  mocks.client = client;
  for (const listener of [...mocks.listeners]) listener();
};
const flush = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.client = null;
});

afterEach(() => {
  cleanup();
  setCloudResourcesReader(null);
  vi.useRealTimers();
});

describe("storage levels", () => {
  it("is full when writes are about to fail, and almost full only when both the share and the room are small", () => {
    expect(storageLevel(disk(20 * GIB))).toBe("ok");
    expect(storageLevel(disk(1.5 * GIB))).toBe("low");
    expect(storageLevel(disk(100 * MIB))).toBe("full");
    expect(storageLevel(disk(0))).toBe("full");
    // A small disk with a quarter free is not "almost full" for having under 2 GB.
    expect(storageLevel(disk(1.5 * GIB, { totalBytes: 6 * GIB }))).toBe("ok");
    // A huge disk at 3% still has plenty of room.
    expect(storageLevel(disk(30 * GIB, { totalBytes: 1000 * GIB }))).toBe("ok");
    // Not reported, or a filesystem that reports nothing useful: no claim.
    expect(storageLevel(null)).toBe("ok");
    expect(storageLevel(disk(0, { totalBytes: 0 }))).toBe("ok");
  });

  it("counts inodes as space, and ignores a filesystem that has none to count", () => {
    expect(storageLevel(disk(20 * GIB, { availableInodes: 0 }))).toBe("full");
    expect(storageLevel(disk(20 * GIB, { availableInodes: 5_000 }))).toBe("low");
    expect(storageLevel(disk(20 * GIB, { totalInodes: 0, availableInodes: 0 }))).toBe("ok");
    expect(storageNotice(disk(20 * GIB, { availableInodes: 0 }))?.text).toMatch(/no room for more files/);
  });

  it("says how much is left and what to do", () => {
    expect(storageNotice(disk(20 * GIB))).toBeNull();
    expect(storageNotice(disk(100 * MIB))).toMatchObject({ level: "full", text: expect.stringMatching(/disk is full \(100 MB free of 40 GB\).*fail until space is freed.*Nothing already on the disk is lost/) });
    expect(storageNotice(disk(1.5 * GIB))).toMatchObject({ level: "low", text: expect.stringMatching(/almost full \(1\.5 GB free of 40 GB\)/) });
    expect(bytesText(0)).toBe("0 MB");
  });
});

describe("the notice on a cloud session", () => {
  it("asks only a workspace that is connected, and never one that is not", async () => {
    const read = vi.fn().mockResolvedValue(reading(disk(100 * MIB)));
    setCloudResourcesReader(read);
    render(<CloudResourceNotice workspaceKey={KEY} />);
    await flush();
    // Stopped or not yet connected: nothing is asked and nothing is said.
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cloud-storage-notice")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(SAMPLE_MS * 3));
    expect(read).not.toHaveBeenCalled();

    const client = {};
    await act(async () => connect(client));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(client);
    const notice = screen.getByTestId("cloud-storage-notice");
    expect(notice.getAttribute("data-level")).toBe("full");
    expect(notice.getAttribute("role")).toBe("alert");
  });

  it("follows the disk as space is freed, and forgets it when the connection goes", async () => {
    const read = vi.fn().mockResolvedValue(reading(disk(1.5 * GIB)));
    setCloudResourcesReader(read);
    mocks.client = {};
    render(<CloudResourceNotice workspaceKey={KEY} />);
    await flush();
    expect(screen.getByTestId("cloud-storage-notice").getAttribute("data-level")).toBe("low");
    expect(screen.getByTestId("cloud-storage-notice").getAttribute("role")).toBe("status");

    read.mockResolvedValue(reading(disk(20 * GIB)));
    await act(async () => void vi.advanceTimersByTime(SAMPLE_MS));
    await flush();
    expect(screen.queryByTestId("cloud-storage-notice")).toBeNull();

    read.mockResolvedValue(reading(disk(0)));
    await act(async () => void vi.advanceTimersByTime(SAMPLE_MS));
    await flush();
    expect(screen.getByTestId("cloud-storage-notice").getAttribute("data-level")).toBe("full");
    // A read that fails says nothing new about the disk.
    read.mockRejectedValue(new Error("network"));
    await act(async () => void vi.advanceTimersByTime(SAMPLE_MS));
    await flush();
    expect(screen.getByTestId("cloud-storage-notice")).toBeTruthy();
    // Disconnected: what was read is no longer known to be true.
    await act(async () => connect(null));
    await flush();
    expect(screen.queryByTestId("cloud-storage-notice")).toBeNull();
  });

  it("stops asking a runtime that does not report resources, until it is a new connection", async () => {
    const read = vi.fn().mockResolvedValue(null);
    setCloudResourcesReader(read);
    mocks.client = {};
    const { unmount } = render(<CloudResourceNotice workspaceKey={KEY} />);
    await flush();
    await act(async () => void vi.advanceTimersByTime(SAMPLE_MS * 3));
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("cloud-storage-notice")).toBeNull();

    read.mockResolvedValue(reading(disk(0)));
    await act(async () => connect({}));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("cloud-storage-notice")).toBeTruthy();

    unmount();
    await act(async () => void vi.advanceTimersByTime(SAMPLE_MS * 3));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
