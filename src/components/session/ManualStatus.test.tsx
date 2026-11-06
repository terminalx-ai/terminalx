import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { ManualStatusMenu } from "./ManualStatus";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => { cleanup(); invoke.mockReset(); });

async function open() {
  render(<DropdownMenu defaultOpen><DropdownMenuTrigger>Session menu</DropdownMenuTrigger><DropdownMenuContent><ManualStatusMenu sessionId="s1" status="in_review" /></DropdownMenuContent></DropdownMenu>);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Set status" }), { key: "ArrowRight" });
  await screen.findByRole("menuitemradio", { name: "Done" });
}

describe("manual status menu", () => {
  it("shows all five choices with the stored selection, sends the session id and waits for persistence", async () => {
    let finish!: () => void;
    invoke.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await open();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(5);
    expect(screen.getByRole("menuitemradio", { name: "In review" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Done" }));
    expect(invoke).toHaveBeenCalledWith("set_session_status", { sessionId: "s1", status: "done" });
    expect(screen.getByRole("menuitemradio", { name: "Done" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("menuitemradio", { name: "Done" })).toBeNull());
  });

  it("keeps the menu and old selection visible when the runtime refuses the edit", async () => {
    invoke.mockRejectedValue(new Error("Runtime disconnected"));
    await open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Canceled" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Runtime disconnected");
    expect(screen.getByRole("menuitemradio", { name: "In review" }).getAttribute("aria-checked")).toBe("true");
  });
});
