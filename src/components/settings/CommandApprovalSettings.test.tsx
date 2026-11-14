import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandApprovalSettings } from "./CommandApprovalSettings";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(cleanup);
beforeEach(() => invoke.mockReset());

it("loads the owner's setting and saves turning the allow list off", async () => {
  invoke.mockResolvedValueOnce({ readOnlyCommands: true }).mockResolvedValueOnce({ readOnlyCommands: false });
  render(<CommandApprovalSettings />);
  const toggle = screen.getByRole("switch");
  expect(toggle.hasAttribute("disabled")).toBe(true);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(invoke).toHaveBeenLastCalledWith("set_read_only_commands", { enabled: false });
});

it("keeps the saved policy when saving fails and shows the error", async () => {
  invoke.mockResolvedValueOnce({ readOnlyCommands: true }).mockRejectedValueOnce("Could not save settings");
  render(<CommandApprovalSettings />);
  const toggle = screen.getByRole("switch");
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle);
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save settings");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});
