import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), state: { custom: true, pending: false, error: null } }));
vi.mock("@/lib/sidebarOrder", () => ({ useSidebarOrder: () => mocks.state, saveSidebarOrder: mocks.save }));
import { SidebarSortList, useSidebarSortable } from "./SidebarSort";

function Row({ id }: { id: string }) {
  const sort = useSidebarSortable(id);
  return <li data-row={id} ref={sort.ref} style={sort.style}>{sort.handle}<button>Open {id}</button></li>;
}
const items = ["Alpha", "Bravo", "Charlie"].map((id) => ({ id, name: id }));
const mount = (kind: "sessions" | "projects" = "sessions") => render(<ul><SidebarSortList items={items} kind={kind}>{items.map(({ id }) => <Row key={id} id={id} />)}</SidebarSortList></ul>);
const key = async (target: Element | Document, code: string) => { await act(async () => { fireEvent.keyDown(target, { code, key: code === "Space" ? " " : code }); }); };
const announcement = () => [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent).join(" ");

beforeEach(() => {
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
