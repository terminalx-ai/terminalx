import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessibilityPress, mouseClick } from "@/test/press";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { RegisteredSetting } = await import("./settingsRegistry");
const { SettingRowActions } = await import("./SettingRowActions");
const { forgetSettingToasts, getSettingToasts } = await import("@/lib/settingsToasts");

afterEach(() => { cleanup(); forgetSettingToasts(); invoke.mockReset(); invoke.mockImplementation(async () => undefined); });

describe("setting row actions", () => {
  it("opens from a registry row and shows Copy setting link with the row id", async () => {
    render(<RegisteredSetting setting="general.sounds" control={<span>Switch</span>} />);
    mouseClick(screen.getByRole("button", { name: "Actions for Sounds" }));
    const item = await screen.findByRole("menuitem", { name: "Copy setting link" });
    expect(item.textContent).toContain("general.sounds");
    expect(item.getAttribute("aria-describedby") && document.getElementById(item.getAttribute("aria-describedby")!)?.textContent).toBe("general.sounds");
  });

  it("sits beside the row's title, outside the name a control takes from it", () => {
    render(<RegisteredSetting setting="general.sounds" id="sounds-label" control={<button aria-labelledby="sounds-label">x</button>} />);
    const actions = screen.getByRole("button", { name: "Actions for Sounds" });
    expect(actions.parentElement).toBe(document.getElementById("sounds-label")!.parentElement);
    expect(document.getElementById("sounds-label")!.textContent).toBe("Sounds");
    expect(screen.getByRole("button", { name: "Sounds" })).toBeTruthy();
  });

  it("names each instance of a repeated row, and links to the row", async () => {
    render(<RegisteredSetting setting="organizations.organization" instance="org-1" label="Procyon" description="owner" control={<span>Open</span>} />);
    mouseClick(screen.getByRole("button", { name: "Actions for Procyon" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy setting link" }));
    await waitFor(() => expect(getSettingToasts().map((toast) => toast.message)).toEqual(["Copied a link to Organization"]));
    expect(invoke).toHaveBeenCalledWith("copy_text", { text: "terminalx://settings/organizations.organization" });
  });

  it("copies the link, then says so", async () => {
    render(<SettingRowActions id="general.promptMap" title="Prompt map" />);
    accessibilityPress(screen.getByRole("button", { name: "Actions for Prompt map" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy setting link" }));
    await waitFor(() => expect(getSettingToasts().map((toast) => toast.message)).toEqual(["Copied a link to Prompt map"]));
    expect(invoke).toHaveBeenCalledWith("copy_text", { text: "terminalx://settings/general.promptMap" });
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("says when the clipboard refused the link", async () => {
    invoke.mockImplementation(async () => { throw new Error("no clipboard"); });
    const writeText = vi.fn(async () => { throw new Error("denied"); });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<SettingRowActions id="general.sounds" title="Sounds" />);
      accessibilityPress(screen.getByRole("button", { name: "Actions for Sounds" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Copy setting link" }));
      await waitFor(() => expect(getSettingToasts().map((toast) => toast.message)).toEqual(["Couldn’t copy a link to Sounds"]));
      expect(writeText).toHaveBeenCalledWith("terminalx://settings/general.sounds");
    } finally { Reflect.deleteProperty(navigator, "clipboard"); }
  });
});
