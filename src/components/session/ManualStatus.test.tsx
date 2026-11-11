import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncContextMenu as ContextMenu, ContextMenuContent, ContextMenuTrigger, AsyncDropdownMenu as DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { ManualStatusIcon, ManualStatusMenu } from "./ManualStatus";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { cleanup(); invoke.mockReset(); });

async function open(contextMenu = false) {
  if (contextMenu) {
    render(<ContextMenu><ContextMenuTrigger>Session menu</ContextMenuTrigger><ContextMenuContent><ManualStatusMenu sessionId="s1" status="in_review" contextMenu /></ContextMenuContent></ContextMenu>);
    fireEvent.contextMenu(screen.getByText("Session menu"));
  } else {
    render(<DropdownMenu defaultOpen><DropdownMenuTrigger>Session menu</DropdownMenuTrigger><DropdownMenuContent><ManualStatusMenu sessionId="s1" status="in_review" /></DropdownMenuContent></DropdownMenu>);
  }
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Set status" }), { key: "ArrowRight" });
  await screen.findByRole("menuitemradio", { name: "Done" });
}

describe("manual status menu", () => {
  it.each([false, true])("closes the whole menu only after persistence (context menu: %s)", async (contextMenu) => {
    let finish!: () => void;
    invoke.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await open(contextMenu);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    expect(screen.getByRole("menuitemradio", { name: "In review" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
    expect(invoke).toHaveBeenCalledWith("set_session_status", { sessionId: "s1", status: "done" });
    expect(screen.getByRole("menuitemradio", { name: "Done" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["triage", null, undefined])("uses the Backlog icon colour for an unknown or absent status: %s", (status) => {
    const { container } = render(<ManualStatusIcon status={status} />);
    expect(container.querySelector("svg")?.style.color).toBe("var(--status-backlog)");
  });

  it("keeps the menu and old selection visible when the runtime refuses the edit", async () => {
    invoke.mockRejectedValue(new Error("Runtime disconnected"));
    await open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Canceled" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Runtime disconnected");
    expect(screen.getByRole("menuitemradio", { name: "In review" }).getAttribute("aria-checked")).toBe("true");
  });
});
