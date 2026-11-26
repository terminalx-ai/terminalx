import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationAutomationsList } from "./OrganizationAutomationsList";

const { cloudAutomations, runNow, confirm, showError, opened, authority } = vi.hoisted(() => ({
  cloudAutomations: vi.fn(),
  runNow: vi.fn(),
  confirm: vi.fn(),
  showError: vi.fn(),
  opened: vi.fn(),
  authority: { stamp: "initial", allowed: true },
}));

vi.mock("@/lib/api", () => ({ api: { cloudAutomations, cloudAutomationRunNow: runNow } }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: confirm }));
vi.mock("@/lib/errorToasts", () => ({ showError }));
vi.mock("@/components/cloud/CloudSchedulesDialog", () => ({ openSchedulesDialog: opened }));
vi.mock("@/components/cloud/CloudAutomationScope", () => ({
  useAutomationScope: () => authority,
  useAutomationFence: () => capture,
}));

function capture() {
  const stamp = authority.stamp;
  return () => stamp === authority.stamp && authority.allowed;
}

const cloudRow = {
  id: "schedule-1",
  workspaceId: "workspace-1",
  name: "Cloud check",
  state: "active",
  webhookTrigger: {},
  creator: { userId: "user-1", displayName: "Sam" },
};

const props = {
  organizationId: "org-a",
  listVersion: 0,
  locals: [{ id: "local-1", name: "Local check", trigger: "Every day", paused: false }],
  localLoading: false,
  onSelectLocal: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authority.allowed = true;
  authority.stamp = "initial";
});

describe("Organization automations list", () => {
  it("shows both sources in All and filters rows by source", async () => {
    cloudAutomations.mockResolvedValue({ schedules: [cloudRow] });
    render(<OrganizationAutomationsList {...props} />);
    await screen.findByText("Sam");
    expect(cloudAutomations).toHaveBeenCalledWith(null, "org-a");
    expect(screen.getByRole("columnheader", { name: "Trigger" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "This Mac" }));
    expect(screen.queryByText("Cloud check")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Local check" }));
    expect(props.onSelectLocal).toHaveBeenCalledWith("local-1");
    fireEvent.click(screen.getByRole("radio", { name: "Cloud" }));
    expect(screen.queryByText("Local check")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cloud check" }));
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", workspaceId: "workspace-1" }));
  });

  it("confirms spend and reuses the request key when the first result is lost", async () => {
    cloudAutomations.mockResolvedValue({ schedules: [cloudRow] });
    confirm.mockResolvedValueOnce(false).mockResolvedValue(true);
    runNow.mockRejectedValueOnce(new Error("Connection ended")).mockResolvedValueOnce({ run: { id: "run-1", state: "queued", scheduledFor: 1 }, duplicate: true });
    render(<OrganizationAutomationsList {...props} />);
    const run = await screen.findByRole("button", { name: "Run Cloud check now" });
    await act(async () => { fireEvent.click(run); });
    expect(runNow).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(run); });
    expect(showError).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(run); });
    const [org, id, key, consent] = runNow.mock.calls[0];
    expect([org, id, typeof key, consent]).toEqual(["org-a", "schedule-1", "string", true]);
    expect(runNow.mock.calls[1]).toEqual(runNow.mock.calls[0]);
    expect(screen.getByText("The run was already requested.")).toBeTruthy();
    expect(screen.getByText(/Latest run · Waiting to start/i)).toBeTruthy();
  });

  it("discards a late response when authority changes and makes no request while unavailable", async () => {
    let resolve!: (value: { schedules: typeof cloudRow[] }) => void;
    cloudAutomations.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<OrganizationAutomationsList {...props} />);
    authority.stamp = "signed-out";
    authority.allowed = false;
    view.rerender(<OrganizationAutomationsList {...props} />);
    await act(async () => { resolve({ schedules: [cloudRow] }); });
    expect(screen.queryByText("Cloud check")).toBeNull();
    expect(screen.getByText("Cloud automations unavailable.")).toBeTruthy();
    expect(cloudAutomations).toHaveBeenCalledTimes(1);
  });
});
