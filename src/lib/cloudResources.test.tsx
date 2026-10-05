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

const { bytesText, memoryLow, memoryNoticeText, SAMPLE_MS, setCloudResourcesReader, storageLevel, storageNotice, TURN_SAMPLE_MS } = await import("./cloudResources");
const { CloudResourceNotice } = await import("@/components/cloud/CloudResourceNotice");

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KEY = "cloud:org-1:ws-1";
const disk = (availableBytes: number, fields: Partial<NonNullable<RuntimeResources["storage"]>> = {}) => ({ totalBytes: 40 * GIB, availableBytes, totalInodes: 1_000_000, availableInodes: 500_000, ...fields });
const reading = (storage: RuntimeResources["storage"], memory: RuntimeResources["memory"] = null): RuntimeResources => ({ v: 1, memory, storage, observedAt: 1 });
const ram = (availableBytes: number, totalBytes = 4 * GIB) => ({ totalBytes, availableBytes });
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
    expect(storageNotice(disk(20 * GIB, { availableInodes: 0 }))?.text).toMatch(/disk is full \(it has reached its limit on the number of files, with 20 GB free of 40 GB\)/);
    // The real reason is named even when bytes are short too, but not short enough to be the cause.
    expect(storageNotice(disk(1 * GIB, { totalBytes: 6 * GIB, availableInodes: 0 }))?.text).toMatch(/disk is full \(it has reached its limit on the number of files, with 1\.0 GB free of 6\.0 GB\)/);
    expect(storageNotice(disk(20 * GIB, { availableInodes: 5_000 }))?.text).toMatch(/almost full \(it is close to its limit on the number of files/);
    // Out of bytes and of inodes: the bytes are what is said.
    expect(storageNotice(disk(10 * MIB, { availableInodes: 0 }))?.text).toMatch(/disk is full \(10 MB free of 40 GB\)/);
  });

  it("says how much is left and what to do", () => {
    expect(storageNotice(disk(20 * GIB))).toBeNull();
    expect(storageNotice(disk(100 * MIB))).toMatchObject({ level: "full", text: expect.stringMatching(/disk is full \(100 MB free of 40 GB\).*fail until space is freed.*Nothing already on the disk is lost/) });
    expect(storageNotice(disk(1.5 * GIB))).toMatchObject({ level: "low", text: expect.stringMatching(/almost full \(1\.5 GB free of 40 GB\)/) });
    expect(bytesText(0)).toBe("0 MB");
    // Someone without a terminal there is told who can free space, not to use one.
    expect(storageNotice(disk(100 * MIB), true)?.text).toMatch(/delete files or build output from a terminal/);
    expect(storageNotice(disk(100 * MIB), false)?.text).toMatch(/someone who manages this workspace can delete files or build output/);
    expect(storageNotice(disk(100 * MIB), false)?.text).not.toMatch(/from a terminal/);
    expect(storageNotice(disk(1.5 * GIB), false)?.text).toMatch(/someone who manages this workspace/);
    expect(storageNotice(disk(100 * MIB))?.text).toMatch(/refused, not half-applied/);
    expect(memoryNoticeText(ram(300 * MIB), false)).toMatch(/Someone who manages this workspace can stop programs/);
    expect(memoryNoticeText(ram(300 * MIB), true)).toMatch(/Stop programs you do not need from a terminal/);
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

describe("low memory during an agent turn (PRO-33)", () => {
  const memoryNotice = () => screen.queryByTestId("cloud-memory-notice");
  const tick = async (ms: number) => {
    await act(async () => void vi.advanceTimersByTime(ms));
    await flush();
  };

  it("is low only under both 10% of RAM and 512 MiB", () => {
    expect(memoryLow(ram(300 * MIB))).toBe(true);
    // 400 MiB of 2 GiB is under 512 MiB but not under 10%.
    expect(memoryLow(ram(400 * MIB, 2 * GIB))).toBe(false);
    // 3 GiB of 64 GiB is under 10% but not under 512 MiB.
    expect(memoryLow(ram(3 * GIB, 64 * GIB))).toBe(false);
    expect(memoryLow(ram(2 * GIB))).toBe(false);
    expect(memoryLow(null)).toBe(false);
    expect(memoryLow(ram(0, 0))).toBe(false);
  });

  it("warns after three low readings in a row while a turn runs, at the turn's pace", async () => {
    const read = vi.fn().mockResolvedValue(reading(disk(20 * GIB), ram(300 * MIB)));
    setCloudResourcesReader(read);
    mocks.client = {};
    render(<CloudResourceNotice workspaceKey={KEY} turn />);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(memoryNotice()).toBeNull();
    await tick(TURN_SAMPLE_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(memoryNotice()).toBeNull();
    await tick(TURN_SAMPLE_MS);
    expect(read).toHaveBeenCalledTimes(3);
    expect(memoryNotice()?.textContent).toMatch(/almost out of memory \(300 MB free of 4\.0 GB\).*may be stopped by the machine.*Someone who manages this workspace/);
    expect(memoryNotice()?.getAttribute("role")).toBe("status");
    // The disk has room: nothing is said about it.
    expect(screen.queryByTestId("cloud-storage-notice")).toBeNull();
  });

  it("a reading with room breaks the run, and the warning goes when memory comes back", async () => {
    const read = vi.fn().mockResolvedValue(reading(null, ram(300 * MIB)));
    setCloudResourcesReader(read);
    mocks.client = {};
    render(<CloudResourceNotice workspaceKey={KEY} turn />);
    await flush();
    await tick(TURN_SAMPLE_MS);
    read.mockResolvedValueOnce(reading(null, ram(2 * GIB)));
    await tick(TURN_SAMPLE_MS);
    // Two low, one fine, then two low again: never three in a row.
    await tick(TURN_SAMPLE_MS);
    await tick(TURN_SAMPLE_MS);
    expect(memoryNotice()).toBeNull();
    await tick(TURN_SAMPLE_MS);
    expect(memoryNotice()).toBeTruthy();
    read.mockResolvedValue(reading(null, ram(2 * GIB)));
    await tick(TURN_SAMPLE_MS);
    expect(memoryNotice()).toBeNull();
  });

  it("says nothing outside a turn, and drops the warning when the turn ends", async () => {
    const read = vi.fn().mockResolvedValue(reading(null, ram(100 * MIB)));
    setCloudResourcesReader(read);
    mocks.client = {};
    const view = render(<CloudResourceNotice workspaceKey={KEY} />);
    await flush();
    for (let i = 0; i < 4; i += 1) await tick(SAMPLE_MS);
    // Idle: asked at the slow pace, and low memory with nothing running is not a warning.
    expect(read).toHaveBeenCalledTimes(5);
    expect(memoryNotice()).toBeNull();

    view.rerender(<CloudResourceNotice workspaceKey={KEY} turn />);
    await flush();
    await tick(TURN_SAMPLE_MS);
    expect(memoryNotice()).toBeNull();
    await tick(TURN_SAMPLE_MS);
    expect(memoryNotice()).toBeTruthy();

    view.rerender(<CloudResourceNotice workspaceKey={KEY} />);
    await flush();
    expect(memoryNotice()).toBeNull();
    const calls = read.mock.calls.length;
    await tick(TURN_SAMPLE_MS * 3);
    expect(read.mock.calls.length).toBe(calls);
  });

  it("a workspace that disconnects mid-turn loses the warning with the connection", async () => {
    const read = vi.fn().mockResolvedValue(reading(null, ram(100 * MIB)));
    setCloudResourcesReader(read);
    mocks.client = {};
    render(<CloudResourceNotice workspaceKey={KEY} turn />);
    await flush();
    await tick(TURN_SAMPLE_MS);
    await tick(TURN_SAMPLE_MS);
    expect(memoryNotice()).toBeTruthy();
    await act(async () => connect(null));
    await flush();
    expect(memoryNotice()).toBeNull();
    // Reconnected: three fresh readings are needed again.
    await act(async () => connect({}));
    await flush();
    expect(memoryNotice()).toBeNull();
  });
});
