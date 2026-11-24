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
  it("says the name follows the system while nobody chose one", async () => {
    mocks.current = { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
    render(<MachineNameSettings />);
    await waitFor(() => expect((screen.getByTestId("machine-name") as HTMLInputElement).value).toBe("Paresh’s MacBook Pro"));
    expect(screen.getByTestId("machine-name-settings").textContent).toContain("It is the system’s own name for it, and changes with it.");
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
    // The name is an inline field beside its label (PRO-375), not a button that opens one.
    expect(screen.getByRole("textbox", { name: "This computer’s name" })).toBe(screen.getByTestId("machine-name"));
  });

  it("offers the computer's own name back once another was chosen", async () => {
    mocks.current = { name: "Studio", chosen: true, computerName: "Paresh’s Mac mini" };
    mocks.setMachineName.mockResolvedValue({ name: "Paresh’s Mac mini", chosen: false, computerName: "Paresh’s Mac mini" });
    render(<MachineNameSettings />);
    await waitFor(() => expect((screen.getByTestId("machine-name") as HTMLInputElement).value).toBe("Studio"));
    expect(screen.getByTestId("machine-name-settings").textContent).toContain("The system calls this computer “Paresh’s Mac mini”.");
    fireEvent.click(screen.getByRole("button", { name: "Use “Paresh’s Mac mini”" }));
    await waitFor(() => expect(mocks.setMachineName).toHaveBeenCalledWith(null));
    await waitFor(() => expect((screen.getByTestId("machine-name") as HTMLInputElement).value).toBe("Paresh’s Mac mini"));
    expect(screen.queryByRole("button", { name: /^Use / })).toBeNull();
  });

  it("leaves the name as it was when renaming is cancelled, emptied or refused", async () => {
    mocks.current = { name: "Studio", chosen: false, computerName: "Studio" };
    mocks.setMachineName.mockRejectedValue(new Error("machine name must contain 1 to 80 visible characters"));
    render(<MachineNameSettings />);
    await waitFor(() => expect((screen.getByTestId("machine-name") as HTMLInputElement).value).toBe("Studio"));
    const input = screen.getByRole("textbox", { name: "This computer’s name" }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Desk" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("Studio");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(input.value).toBe("Studio");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.setMachineName).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Desk" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toBe("machine name must contain 1 to 80 visible characters");
    expect(input.value).toBe("Desk");
  });

  it("saves a new name when the field loses focus", async () => {
    mocks.current = { name: "Studio", chosen: false, computerName: "Studio" };
    mocks.setMachineName.mockResolvedValue({ name: "Desk", chosen: true, computerName: "Studio" });
    render(<MachineNameSettings />);
    await waitFor(() => expect((screen.getByTestId("machine-name") as HTMLInputElement).value).toBe("Studio"));
    const input = screen.getByRole("textbox", { name: "This computer’s name" });
    fireEvent.change(input, { target: { value: "  Desk " } });
    fireEvent.blur(input);
    await waitFor(() => expect(mocks.setMachineName).toHaveBeenCalledWith("Desk"));
    await waitFor(() => expect(screen.getByTestId("machine-name-settings").textContent).toContain("“You · on Desk”"));
  });
});
