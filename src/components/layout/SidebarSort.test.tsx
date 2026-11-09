import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), state: { custom: true, pending: false, error: null } }));
vi.mock("@/lib/sidebarOrder", () => ({ useSidebarOrder: () => mocks.state, saveSidebarOrder: mocks.save }));
import type { SessionEntry } from "@/types/session";
import { setPrefs } from "@/lib/prefs";
import { SidebarSortList, SortableStatusGroups, useSidebarSortable } from "./SidebarSort";

function Row({ id }: { id: string }) {
  const sort = useSidebarSortable(id);
  return <li data-row={id} ref={sort.ref} style={sort.style}>{sort.handle}<button>Open {id}</button></li>;
}
const items = ["Alpha", "Bravo", "Charlie"].map((id) => ({ id, name: id }));
const mount = (kind: "sessions" | "projects" = "sessions") => render(<ul><SidebarSortList items={items} kind={kind}>{items.map(({ id }) => <Row key={id} id={id} />)}</SidebarSortList></ul>);
const key = async (target: Element | Document, code: string) => { await act(async () => { fireEvent.keyDown(target, { code, key: code === "Space" ? " " : code }); }); };
const announcement = () => [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ");

beforeEach(() => {
  setPrefs({ sidebarSections: {}, animations: false });
  mocks.save.mockReset();
  mocks.state.custom = true;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = items.findIndex((item) => item.id === this.dataset.row);
    const top = Math.max(0, index) * 40;
    return { x: 0, y: top, top, bottom: top + 32, left: 0, right: 200, width: 200, height: 32, toJSON() {} } as DOMRect;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("sidebar keyboard drag with the real dnd-kit sensors", () => {
  it.each(["sessions", "projects"] as const)("picks up, moves and drops %s with announcements", async (kind) => {
    const view = mount(kind);
    expect(view.container.querySelector("ul > :not(li)")).toBeNull();
    const handle = screen.getByRole("button", { name: "Reorder Alpha" });
    handle.focus();
    await key(handle, "Space");
    await waitFor(() => expect(announcement()).toContain("Picked up Alpha. Position 1 of 3."));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await key(document, "ArrowDown");
    await waitFor(() => expect(announcement()).toContain("Moved Alpha. Position 2 of 3."));
    if (kind === "sessions") {
      await key(document, "ArrowDown");
      await waitFor(() => expect(announcement()).toContain("Moved Alpha. Position 3 of 3."));
      await key(document, "ArrowDown"); // End of the list: stay in place.
    }
    await key(document, "Space");
    expect(mocks.save).toHaveBeenCalledWith({ [kind]: kind === "sessions" ? ["Bravo", "Charlie", "Alpha"] : ["Bravo", "Alpha", "Charlie"] });
    await waitFor(() => expect(announcement()).toContain(`Dropped Alpha. Position ${kind === "sessions" ? 3 : 2} of 3.`));
    expect(document.activeElement).toBe(handle);
  });
  it("cancels without saving and ignores ordinary row buttons", async () => {
    mount();
    const open = screen.getByRole("button", { name: "Open Alpha" });
    open.focus();
    await key(open, "Space");
    expect(announcement()).not.toContain("Picked up");
    const handle = screen.getByRole("button", { name: "Reorder Bravo" });
    handle.focus();
    await key(handle, "Space");
    await waitFor(() => expect(announcement()).toContain("Picked up Bravo. Position 2 of 3."));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await key(document, "ArrowLeft");
    await waitFor(() => expect(announcement()).toContain("Moved Bravo. Position 1 of 3."));
    await key(document, "Escape");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(announcement()).toContain("Cancelled. Bravo. Position 2 of 3.");
  });
  it("offers no drag handles while custom ordering is off", () => {
    mocks.state.custom = false;
    mount();
    expect(screen.queryByRole("button", { name: /Reorder/ })).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[id^="DndDescribedBy"]')).toBeNull();
  });
});

const sessions: SessionEntry[] = items.map(({ id }, index) => ({
  id, title: id, tabs: [], activeTab: "", manualStatus: index < 2 ? "backlog" : "done",
  projectPath: "/a", cwd: "/a", created: "2026-01-01", modified: "2026-01-01",
  archived: false, pinned: false, worktreeRemoved: false,
}));
const grouped = (rows = sessions) => <ul><SortableStatusGroups sessions={rows}>{({ id }) => <Row key={id} id={id} />}</SortableStatusGroups></ul>;

it("steps only within the current status and saves only that group's rows", async () => {
  render(grouped());
  const handle = screen.getByRole("button", { name: "Reorder Alpha" });
  handle.focus();
  await key(handle, "Space");
  await waitFor(() => expect(announcement()).toContain("Picked up Alpha. Position 1 of 2."));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await key(document, "ArrowDown");
  await waitFor(() => expect(announcement()).toContain("Moved Alpha. Position 2 of 2."));
  await key(document, "ArrowDown"); // Charlie is next on screen, in Done: cannot cross.
  await key(document, "Space");
  expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ sessions: ["Bravo", "Alpha"] });
  expect(announcement()).toContain("Dropped Alpha. Position 2 of 2.");
  expect(screen.getByRole("button", { name: "Done 1" })).toBeTruthy();
});

it("cancels a stale drop when a remote status change moves its target to another group", async () => {
  const view = render(grouped());
  const handle = screen.getByRole("button", { name: "Reorder Alpha" });
  handle.focus();
  await key(handle, "Space");
  await waitFor(() => expect(announcement()).toContain("Picked up Alpha. Position 1 of 2."));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await key(document, "ArrowDown");
  await waitFor(() => expect(announcement()).toContain("Moved Alpha. Position 2 of 2."));
  view.rerender(grouped(sessions.map((row) => row.id === "Bravo" ? { ...row, manualStatus: "done" } : row)));
  expect(screen.getByRole("button", { name: "Backlog 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done 2" })).toBeTruthy();
  await key(document, "Space");
  expect(mocks.save).not.toHaveBeenCalled();
});

it("keeps status collapse independent across sections while counts react to a status change", () => {
  const content = (rows: SessionEntry[]) => <ul>
    <SortableStatusGroups sessions={rows} scope="local-section:release">{({ id }) => <Row key={id} id={id} />}</SortableStatusGroups>
    <SortableStatusGroups sessions={[{ ...sessions[2], id: "other", title: "Other", manualStatus: "backlog" }]} scope="local">{({ id }) => <Row key={id} id={id} />}</SortableStatusGroups>
  </ul>;
  const view = render(content(sessions));
  fireEvent.click(screen.getByRole("button", { name: "Backlog 2" }));
  expect(screen.queryByRole("button", { name: "Reorder Alpha" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reorder Charlie" })).toBeTruthy();
  view.rerender(content(sessions.map((row) => row.id === "Alpha" ? { ...row, manualStatus: "done" } : row)));
  const backlog = screen.getAllByRole("button", { name: "Backlog 1" });
  expect(backlog.map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  expect(screen.getByRole("button", { name: "Done 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reorder Alpha" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Reorder Bravo" })).toBeNull();
});
