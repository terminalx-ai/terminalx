import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineName } from "@/types/pairing";

const mocks = vi.hoisted(() => ({
  current: null as MachineName | null,
  machineName: vi.fn(),
  setMachineName: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { machineName: mocks.machineName, setMachineName: mocks.setMachineName },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const { MachineNameSettings } = await import("./MachineNameSettings");

beforeEach(() => {
  mocks.machineName.mockReset().mockImplementation(async () => mocks.current);
  mocks.setMachineName.mockReset();
});
afterEach(cleanup);

describe("this Mac's name (#686)", () => {
  it("says the name follows System Settings while nobody chose one", async () => {
    mocks.current = { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
    render(<MachineNameSettings />);
    await waitFor(() => expect(screen.getByTestId("machine-name").textContent).toBe("Paresh’s MacBook Pro"));
    expect(screen.getByTestId("machine-name-settings").textContent).toContain("System Settings → General → About, and changes with it.");
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    // The rename control is a visible button, not a pencil that shows on hover.
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
  });

  it("offers the computer's own name back once another was chosen", async () => {
    mocks.current = { name: "Studio", chosen: true, computerName: "Paresh’s Mac mini" };
    mocks.setMachineName.mockResolvedValue({ name: "Paresh’s Mac mini", chosen: false, computerName: "Paresh’s Mac mini" });
    render(<MachineNameSettings />);
    await waitFor(() => expect(screen.getByTestId("machine-name").textContent).toBe("Studio"));
    expect(screen.getByTestId("machine-name-settings").textContent).toContain("In System Settings this Mac is called “Paresh’s Mac mini”.");
    fireEvent.click(screen.getByRole("button", { name: "Use “Paresh’s Mac mini”" }));
    await waitFor(() => expect(mocks.setMachineName).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.getByTestId("machine-name").textContent).toBe("Paresh’s Mac mini"));
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("leaves the name as it was when renaming is cancelled or refused", async () => {
    mocks.current = { name: "Studio", chosen: false, computerName: "Studio" };
    mocks.setMachineName.mockRejectedValue(new Error("machine name must contain 1 to 80 visible characters"));
    render(<MachineNameSettings />);
    await waitFor(() => expect(screen.getByTestId("machine-name").textContent).toBe("Studio"));

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "This Mac’s name" });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("machine-name").textContent).toBe("Studio");

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "This Mac’s name" }), { target: { value: "Desk" } });
    fireEvent.submit(screen.getByRole("textbox", { name: "This Mac’s name" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("machine name must contain 1 to 80 visible characters");
    expect((screen.getByRole("textbox", { name: "This Mac’s name" }) as HTMLInputElement).value).toBe("Desk");
  });
});
