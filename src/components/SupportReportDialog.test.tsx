import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openSupportReport, SupportReportDialog } from "./SupportReportDialog";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.40" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: { state: "signed-in", context: { revision: "session-revision" } } }) }));

const reference = "de94bbc7-3533-493a-81c8-19facc031340";
const local = { status: "included", platform: "macos", appVersion: "0.2.40", capturedAt: 2000, truncated: false, coverage: { from: 1000, to: 2000 }, events: [{ at: 1500, kind: "relay-closed" }] };
const calls = (name: string) => invoke.mock.calls.filter(([command]) => command === name);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) => {
    if (name === "support_report_preview") return {
      key: reference, from: 1000, to: 2000, server: { status: "empty", capturedAt: 2000, truncated: false, events: [] },
    };
    if (name === "support_report_local") return { local, proof: "native-proof" };
    throw "unavailable";
  });
});
afterEach(cleanup);

function open() {
  render(<SupportReportDialog />);
  act(openSupportReport);
}

it("starts collection only on preview and sends nothing when canceled", async () => {
  open();
  fireEvent.click(screen.getByLabelText(/runtime connections/));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Prepare preview"));
  await screen.findByText("Desktop connections: Included");
  expect(calls("support_report_local")).toHaveLength(1);
  fireEvent.click(screen.getByText("Cancel"));
  expect(calls("support_report_submit")).toHaveLength(0);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retries the same reviewed snapshot and waits for a confirmed reference", async () => {
  open();
  fireEvent.click(screen.getByText("Prepare preview"));
  fireEvent.click(await screen.findByText("Send to TerminalX Support"));
  await screen.findByRole("alert");
  expect(screen.queryByText("Report delivered")).toBeNull();
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, args) => name === "support_report_submit" ? { reference } : original(name, args));
  fireEvent.click(screen.getByText("Retry same report"));
  await screen.findByText("Report delivered");
  expect(calls("support_report_submit")).toHaveLength(2);
  expect(calls("support_report_submit")[0]).toEqual(calls("support_report_submit")[1]);
});

it("offers a local preview and no Send when the service is offline", async () => {
  invoke.mockImplementation(async (name) => {
    if (name === "support_report_local") return { local, proof: "native-proof" };
    throw "unavailable";
  });
  open();
  fireEvent.click(screen.getByLabelText(/Server events for this account/));
  fireEvent.click(screen.getByText("Prepare preview"));
  await screen.findByText("Account server events: Unavailable");
  expect(screen.getByText("Copy local report")).toBeTruthy();
  await waitFor(() => expect((screen.getByText("Send to TerminalX Support") as HTMLButtonElement).disabled).toBe(true));
});

it("discards a desktop preview when native copy rejects its organization scope", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, args) => {
    if (name === "support_report_copy") throw "support_scope_changed";
    return original(name, args);
  });
  open();
  fireEvent.click(screen.getByLabelText(/runtime connections/));
  fireEvent.click(screen.getByText("Prepare preview"));
  fireEvent.click(await screen.findByText("Copy local report"));
  await screen.findByText(/organization access changed/);
  expect(calls("support_report_copy")[0]?.[1]).toEqual({
    revision: "session-revision", proof: "native-proof",
    draft: { from: 1000, to: 2000, local, problem: { feature: "connection", symptom: "failed" } },
  });
  expect(screen.queryByText("Send to TerminalX Support")).toBeNull();
});
