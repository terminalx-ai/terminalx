import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, SessionEntry } from "@/types/session";
import { operateSelfUi, registerSelfUiFold, type SelfUiRequest } from "./selfUi";
import { pipelineSettings } from "@/lib/pipelineLaunch";
import { SessionPipelineControls } from "@/components/session/SessionPipelineControls";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), selected: "s", open: vi.fn(), panel: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/sessions", () => ({ getSessionStore: () => ({ selectedSessionId: mocks.selected }), openTarget: mocks.open }));
vi.mock("@/lib/panelTab", () => ({ showPanelTab: mocks.panel }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
const session = { id: "s", projectPath: "/repo", cwd: "/repo/worktree", tabs: [{ id: "t" }], issue: { id: "871" } } as SessionEntry;
const project = { path: "/repo", issuePipeline: { enabled: true } } as Project;
function request(action: SelfUiRequest["action"]): SelfUiRequest {
  return { id: "native-request", sessionId: "s", tabId: "t", action, actions: ["toggle-merge", "toggle-conflicts", "start-autopilot", "adopt-pr", "open-autopilot"], expiresAt: Date.now() + 60_000 };
}
beforeEach(() => {
  mocks.selected = "s";
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(null);
  mocks.open.mockReset();
  mocks.panel.mockReset();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 50 }] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("inspects and operates only approved controls and verifies the new switch value", async () => {
  render(<><aside>Unrelated session: PRIVATE TOKEN</aside><SessionPipelineControls session={session} project={project} tabId="t" /></>);
  const before = await operateSelfUi(request("snapshot"));
  expect(before.controls.find((control) => control.id === "toggle-merge")?.checked).toBe(true);
  let result;
  await act(async () => { result = await operateSelfUi(request("toggle-merge")); });
  expect(result).toMatchObject({ sessionId: "s", tabId: "t", controls: expect.arrayContaining([{ id: "toggle-merge", enabled: true, checked: false }]) });
  expect(screen.getByRole("switch", { name: "Merge when green" }).getAttribute("aria-checked")).toBe("false");
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(mocks.invoke).toHaveBeenCalledWith("self_ui_validate", { id: "native-request" });
});
it("rejects another session, tab, hidden panel, modal, expiry and revoked native request", async () => {
  const view = render(<SessionPipelineControls session={session} project={project} tabId="t" />);
  mocks.selected = "private";
  await expect(operateSelfUi(request("toggle-merge"))).rejects.toThrow("not visible");
  mocks.selected = "s";
  await expect(operateSelfUi({ ...request("toggle-merge"), tabId: "other" })).rejects.toThrow("not visible");
  view.container.setAttribute("inert", "");
  await expect(operateSelfUi(request("toggle-merge"))).rejects.toThrow("not visible");
  view.container.removeAttribute("inert");
  const dialog = document.createElement("div"); dialog.setAttribute("role", "alertdialog"); document.body.append(dialog);
  await expect(operateSelfUi(request("toggle-merge"))).rejects.toThrow("dialog");
  dialog.remove();
  await expect(operateSelfUi({ ...request("toggle-merge"), expiresAt: Date.now() - 1 })).rejects.toThrow("expired");
  await expect(operateSelfUi({ ...request("toggle-merge"), actions: ["start-autopilot"] })).rejects.toThrow("not authorized");
  mocks.invoke.mockRejectedValueOnce(new Error("revoked"));
  await expect(operateSelfUi(request("toggle-merge"))).rejects.toThrow("revoked");
  expect(screen.getByRole("switch", { name: "Merge when green" }).getAttribute("aria-checked")).toBe("true");
});
it("opens the authorized session's Branch and Autopilot fold", async () => {
  render(<SessionPipelineControls session={session} project={project} tabId="t" />);
  const open = vi.fn();
  const stop = registerSelfUiFold("s", open);
  const result = await operateSelfUi(request("open-autopilot"));
  expect(mocks.open).toHaveBeenCalledWith({ sessionId: "s", tabId: "t" });
  expect(mocks.panel).toHaveBeenCalledWith("branch");
  expect(open).toHaveBeenCalledOnce();
  expect(result.sessionId).toBe("s");
  stop();
});
it("activates through the native agent path instead of a person handler", async () => {
  mocks.invoke.mockImplementation(async (command) => command === "self_ui_start" ? {
    pipeline: { id: "adopted", author: { sessionId: "s", tabId: "t" }, state: "waiting" }, authorBrief: "brief",
  } : null);
  render(<SessionPipelineControls session={session} project={project} tabId="t" />);
  let result;
  await act(async () => { result = await operateSelfUi(request("adopt-pr")); });
  expect(result).toMatchObject({ pipelineId: "adopted" });
  expect(mocks.invoke).toHaveBeenCalledWith("self_ui_start", { id: "native-request", autoMerge: true, resolveConflicts: true });
  expect(mocks.invoke.mock.calls.some(([name]) => name === "issue_pipeline_start" || name === "issue_pipeline_attach")).toBe(false);
});
it("cannot toggle a person-only merge setting", async () => {
  render(<SessionPipelineControls session={session} project={{ ...project, issuePipeline: { ...pipelineSettings(project), requirePerson: true } }} tabId="t" />);
  await expect(operateSelfUi(request("toggle-merge"))).rejects.toThrow("unavailable");
});
