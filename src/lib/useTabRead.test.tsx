import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTabRead } from "./useTabRead";
import type { TabEntry } from "@/types/session";

describe("tab read state", () => {
  it("keeps an open tab's reminder until revisiting it, including while waiting or working", () => {
    const read = vi.fn(async () => {});
    const tab: Pick<TabEntry, "id" | "status" | "markedUnread"> = { id: "one", status: "waiting" };
    const { rerender } = renderHook(({ active, markedUnread }) => useTabRead(active, "local", { ...tab, markedUnread }, read), { initialProps: { active: true, markedUnread: false } });
    rerender({ active: true, markedUnread: true });
    expect(read).not.toHaveBeenCalled();
    rerender({ active: false, markedUnread: true });
    expect(read).not.toHaveBeenCalled();
    rerender({ active: true, markedUnread: true });
    expect(read).toHaveBeenCalledExactlyOnceWith("one");
  });
  it("clears a persisted reminder on first open and reads a newly completed turn", () => {
    const read = vi.fn(async () => {});
    const first: Pick<TabEntry, "id" | "status" | "markedUnread"> = { id: "one", status: "idle", markedUnread: true };
    const { rerender } = renderHook(({ tab }: { tab: Pick<TabEntry, "id" | "status" | "markedUnread"> }) => useTabRead(true, "local", tab, read), { initialProps: { tab: first } });
    expect(read).toHaveBeenCalledExactlyOnceWith("one");
    rerender({ tab: { ...first, markedUnread: false, status: "in_progress" } });
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ tab: { ...first, markedUnread: false, status: "completed" } });
    expect(read).toHaveBeenCalledTimes(2);
    rerender({ tab: { id: "two", status: "idle", markedUnread: true } });
    expect(read).toHaveBeenLastCalledWith("two");
  });
  it("keeps a reminder set during the current visit even when the turn finishes", () => {
    const read = vi.fn(async () => {});
    const first: Pick<TabEntry, "id" | "status" | "markedUnread"> = { id: "one", status: "in_progress", markedUnread: false };
    const { rerender } = renderHook(({ tab }) => useTabRead(true, "local", tab, read), { initialProps: { tab: first } });
    rerender({ tab: { ...first, markedUnread: true } });
    rerender({ tab: { ...first, markedUnread: true, status: "completed" } });
    expect(read).not.toHaveBeenCalled();
  });

});
