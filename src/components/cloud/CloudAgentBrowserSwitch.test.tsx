import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";

const m = vi.hoisted(() => ({
  get: vi.fn(), settings: vi.fn(),
  status: { state: "signed-in", phase2Readiness: { org: ["cloud.desktop.agent-browser.v1"] } as Record<string, string[]> },
}));
vi.mock("@/lib/api", async (original) => ({ ...(await original<any>()), api: { cloudWorkspaceAgentBrowser: m.get } }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: m.status }) }));
vi.mock("@/lib/cloudCatalog", () => ({ useCloudCatalog: () => ({ viewerUserId: "me" }) }));
vi.mock("@/lib/settingsLinks", () => ({ openOrganizationSettings: m.settings }));
import { CloudAgentBrowserSwitch, enabledLine } from "./CloudAgentBrowserSwitch";
import { rememberCloudBrowserOffer } from "@/lib/cloudBrowser";
import { cloudWorkspaceKey } from "@/types/target";
const KEY = cloudWorkspaceKey("org", "ws");

const item = { workspace: { id: "ws", orgId: "org", name: "Docs", state: "ready", createdAt: 0 }, latestOperation: null } as CloudWorkspaceListItem;
const state = (text: string) => expect(screen.getByTestId("agent-browser-state").textContent).toBe(text);

beforeEach(() => { vi.clearAllMocks(); m.status.phase2Readiness = { org: ["cloud.desktop.agent-browser.v1"] }; rememberCloudBrowserOffer(KEY, "off"); });
afterEach(cleanup);

it("is absent without readiness, and when the server holds it", async () => {
  m.status.phase2Readiness = {};
  const view = render(<CloudAgentBrowserSwitch item={item} />);
  expect(screen.queryByTestId("agent-tools")).toBeNull();
  expect(m.get).not.toHaveBeenCalled();
  view.unmount();
  m.status.phase2Readiness = { org: ["cloud.desktop.agent-browser.v1"] };
  m.get.mockRejectedValue({ code: "cloud_workspace_agent_browser_unavailable" });
  render(<CloudAgentBrowserSwitch item={item} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByTestId("agent-tools")).toBeNull();
});

it("turns on for an owner and says who did it and when", async () => {
  m.get.mockResolvedValueOnce({ enabled: false, canChange: true });
  m.get.mockResolvedValueOnce({ enabled: true, canChange: true, enabledAt: "2026-11-27T10:28:00Z", enabledBy: { userId: "me", name: "Fixture Owner" } });
  render(<CloudAgentBrowserSwitch item={item} />);
  await screen.findByText("Off · agents here can’t use the desktop’s browser");
  fireEvent.click(screen.getByRole("switch", { name: "Cloud browser for agents" }));
  await screen.findByText(/^On · turned on by you, /);
  expect(m.get).toHaveBeenLastCalledWith("ws", "org", true);
  expect(screen.queryByText("Only the workspace owner and admins can change this.")).toBeNull();
  expect(screen.getByTestId("agent-browser-signed-in").textContent).toBe("It uses the desktop’s Chrome, with any sites signed in there.");
});

it("is read-only for drivers and viewers", async () => {
  m.get.mockResolvedValue({ enabled: true, canChange: false });
  render(<CloudAgentBrowserSwitch item={item} />);
  await screen.findByText("Only the workspace owner and admins can change this.");
  state("On");
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
});

it("says the environment lacks the desktop packages and links to Cloud compute", async () => {
  m.get.mockResolvedValue({ enabled: true, canChange: true });
  rememberCloudBrowserOffer(KEY, "packages-missing");
  render(<CloudAgentBrowserSwitch item={item} />);
  await screen.findByTestId("agent-browser-missing");
  state("Not offered · this environment has no desktop packages");
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open Cloud compute" }));
  expect(m.settings).toHaveBeenCalledWith("org");
});

it("names another enabler only by name, and never by time", () => {
  expect(enabledLine({ enabled: true, canChange: true, enabledBy: { userId: "other", name: "Fixture Admin" }, enabledAt: "2026-11-27T10:28:00Z" }, "me")).toBe("On · turned on by Fixture Admin");
  expect(enabledLine({ enabled: true, canChange: false }, "me")).toBe("On");
});
