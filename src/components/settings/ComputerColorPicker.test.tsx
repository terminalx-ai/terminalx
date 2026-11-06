import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setComputerColor } from "@/lib/account";
import { ComputerColorPicker } from "./ComputerColorPicker";
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { organizations: [{ id: "org", computerColor: "violet" }] } }), setComputerColor: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("offers six named swatches and previews a change while the server saves it", () => {
  vi.mocked(setComputerColor).mockReturnValue(new Promise(() => {}));
  render(<ComputerColorPicker organizationId="org" name="Team" />);
  expect(screen.getAllByRole("button")).toHaveLength(6);
  expect(screen.getByRole("button", { name: "Violet" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Teal" }));
  expect(setComputerColor).toHaveBeenCalledWith("org", "teal");
  expect(screen.getByTestId("computer-color-preview").querySelector("svg")?.style.color).toBe("rgb(45, 212, 191)");
});
it("reports a failed save and returns the preview to the confirmed color", async () => {
  vi.mocked(setComputerColor).mockRejectedValue(new Error("Offline"));
  render(<ComputerColorPicker organizationId="org" name="Team" />); fireEvent.click(screen.getByRole("button", { name: "Teal" }));
  await screen.findByText("Offline");
  await waitFor(() => expect(screen.getByRole("button", { name: "Violet" }).getAttribute("aria-pressed")).toBe("true"));
});
