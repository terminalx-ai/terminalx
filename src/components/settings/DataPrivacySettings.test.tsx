import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native }));
import { refreshDataPrivacy } from "@/lib/dataPrivacy";
import { DataPrivacySettings } from "./DataPrivacySettings";
import { DevicesTab } from "./DevicesTab";
import { OrganizationsTab } from "./OrganizationsTab";
import { PrivacyImage } from "@/components/ui/privacy-image";

beforeEach(() => native.mockReset());
afterEach(cleanup);

it("locks a forced setting and explains what it disables", async () => {
  native.mockResolvedValue({ enabled: true, managed: true });
  await act(refreshDataPrivacy);
  render(<DataPrivacySettings />);
  const control = screen.getByRole("switch", { name: "Data privacy mode" });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(control.matches(":disabled")).toBe(true);
  expect(screen.getByText("Managed by your organisation")).toBeTruthy();
  for (const label of ["Cloud workspaces", "Organisations", "Remote control and pairing", "MCP servers from organisation config", "External logging"]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  native.mockClear();
  fireEvent.click(control);
  expect(native).not.toHaveBeenCalled();
});

it("unmounts organisations and pairing controls when privacy is on", async () => {
  native.mockResolvedValue({ enabled: true, managed: false });
  await act(refreshDataPrivacy);
  native.mockClear();
  render(<><OrganizationsTab /><DevicesTab /></>);
  expect(screen.getAllByText("Turned off by data privacy mode")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /pairing|organization/i })).toBeNull();
  expect(native).not.toHaveBeenCalled();
});

it("blocks webview network images while preserving local attachments", async () => {
  native.mockResolvedValue({ enabled: true, managed: false });
  await act(refreshDataPrivacy);
  const { container } = render(<>
    <PrivacyImage src="https://relay.terminalx.ai/image" alt="remote" />
    <PrivacyImage src="data:image/png;base64,a" alt="local" />
    <PrivacyImage src="http://127.0.0.1:1234/grant" alt="media preview" />
    <PrivacyImage src="http://asset.localhost/attachment.png" alt="attachment" />
    <PrivacyImage src="https://127.0.0.1.attacker.example/picture" alt="lookalike" />
  </>);
  expect(container.querySelector('img[alt="remote"]')).toBeNull();
  expect(container.querySelector('img[alt="local"]')).toBeTruthy();
  expect(container.querySelector('img[alt="media preview"]')).toBeTruthy();
  expect(container.querySelector('img[alt="attachment"]')).toBeTruthy();
  expect(container.querySelector('img[alt="lookalike"]')).toBeNull();
  native.mockResolvedValue({ enabled: false, managed: false });
  await act(refreshDataPrivacy);
  expect(container.querySelector('img[alt="remote"]')).toBeTruthy();
});

it("shows applied off with the synchronization error and does not invent protection", async () => {
  native.mockResolvedValue({ enabled: false, managed: false, error: "Background runtime unavailable" });
  await act(refreshDataPrivacy);
  render(<DataPrivacySettings />);
  expect(screen.getByRole("switch", { name: "Data privacy mode" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("alert").textContent).toBe("Background runtime unavailable");
  native.mockImplementation((command) => command === "data_privacy_status" ? Promise.reject(new Error("IPC unavailable")) : Promise.resolve(null));
  await act(refreshDataPrivacy);
  expect(screen.getByRole("switch", { name: "Data privacy mode" }).getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("switch", { name: "Data privacy mode" }).matches(":disabled")).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Could not verify");
});
