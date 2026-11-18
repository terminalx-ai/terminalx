import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setPrefs } from "@/lib/prefs";
import { AppDestinations } from "./ProjectRail";

vi.mock("./SessionSidebar", () => ({ SessionSidebar: () => null }));
vi.mock("./ChatListSidebar", () => ({ ChatListSidebar: () => null }));
vi.mock("./SessionRowExtras", () => ({ SessionRowData: () => null }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [], view: "agents" }) }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => ({ automations: [] }) }));
vi.mock("@/lib/cloudDashboard", () => ({ useCloudDashboard: () => [] }));
vi.mock("@/lib/organizationVisibility", () => ({ useOrganizationVisibility: () => ({ visibleIds: [] }) }));

beforeEach(() => setPrefs({ shortcuts: {} }));
afterEach(cleanup);

it("keeps Overview keycaps and ARIA in sync with defaults, custom keys, collisions and unbinding", () => {
  render(<AppDestinations onOpenHome={vi.fn()} onNewSession={vi.fn()} onSearch={vi.fn()} onOpenIssues={vi.fn()} onOpenAgents={vi.fn()} onOpenAutomations={vi.fn()} />);
  const overview = screen.getByRole("button", { name: /^Overview/ });
  expect(overview.getAttribute("aria-keyshortcuts")).toBe("Control+1");
  expect(overview.textContent).toContain("Ctrl1");
  act(() => setPrefs({ shortcuts: { "app.agentDashboard": ["mod+shift+a", "mod+0"] } }));
  expect(overview.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+A Control+0");
  expect(overview.textContent).toContain("CtrlShiftA");
  const unboundCases: Record<string, string[]>[] = [{ "session.tab1": ["mod+1"] }, { "app.agentDashboard": [] }];
  for (const shortcuts of unboundCases) {
    act(() => setPrefs({ shortcuts }));
    expect(overview.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(overview.querySelector("kbd")).toBeNull();
  }
});
