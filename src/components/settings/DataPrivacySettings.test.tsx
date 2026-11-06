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
  const { container } = render(<><PrivacyImage src="https://relay.terminalx.ai/image" alt="remote" /><PrivacyImage src="data:image/png;base64,a" alt="local" /></>);
  expect(container.querySelector('img[alt="remote"]')).toBeNull();
  expect(container.querySelector('img[alt="local"]')).toBeTruthy();
  native.mockResolvedValue({ enabled: false, managed: false });
  await act(refreshDataPrivacy);
  expect(container.querySelector('img[alt="remote"]')).toBeTruthy();
});
