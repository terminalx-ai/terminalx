import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { NudgePreference } from "./NudgePreference";

const { current, read, save } = vi.hoisted(() => ({
  current: { enabled: false },
  read: vi.fn(),
  save: vi.fn(),
}));

function account() { return {
  status: {
    state: "signed-in",
    identity: { organizationId: "org-a" },
    context: { revision: "rev-1" },
    phase2Readiness: current.enabled ? { "org-a": ["team.nudges.v1"] } : {},
  } as AccountStatus,
}; }
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@/lib/api", () => ({ api: { nudgePreference: read, nudgePreferenceSet: save } }));
vi.mock("@/lib/dataPrivacy", () => ({
  getDataPrivacy: () => ({ ready: true, enabled: false }),
  useDataPrivacy: () => ({ ready: true, enabled: false }),
}));

afterEach(() => {
  cleanup();
  current.enabled = false;
  vi.clearAllMocks();
});

it("keeps the single switch unavailable until the current organization is ready", async () => {
  read.mockResolvedValue({ enabled: false });
  save.mockResolvedValue({ enabled: true });
  const view = render(<NudgePreference />);
  expect(screen.queryByRole("switch", { name: "Nudges" })).toBeNull();
  expect(read).not.toHaveBeenCalled();
  current.enabled = true;
  view.rerender(<NudgePreference />);
  const toggle = screen.getByRole("switch", { name: "Nudges" }) as HTMLButtonElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(save).toHaveBeenCalledExactlyOnceWith("org-a", true);
});
