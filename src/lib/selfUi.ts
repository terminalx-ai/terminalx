import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushSync } from "react-dom";

export type SelfUiAction = "open-autopilot" | "toggle-merge" | "toggle-conflicts" | "start-autopilot" | "adopt-pr";
export interface SelfUiRequest {
  id: string;
  sessionId: string;
  tabId: string;
  action: SelfUiAction | "snapshot";
  actions: SelfUiAction[];
  expiresAt: number;
}
export interface SelfUiSnapshot {
  sessionId: string;
  tabId: string;
  controls: { id: SelfUiAction; enabled: boolean; checked: boolean | null }[];
  pipelineId: string | null;
  pipelineState: import("@/types/issuePipeline").PipelineState | null;
}
interface Panel {
  element: HTMLElement;
  snapshot(): SelfUiSnapshot;
  click(request: SelfUiRequest): Promise<void>;
}
const panels = new Map<string, Panel>();
const folds = new Map<string, () => void>();
export function registerSelfUiPanel(sessionId: string, panel: Panel) {
  panels.set(sessionId, panel);
  return () => { if (panels.get(sessionId) === panel) panels.delete(sessionId); };
}
export function registerSelfUiFold(sessionId: string, open: () => void) {
  folds.set(sessionId, open);
  return () => { if (folds.get(sessionId) === open) folds.delete(sessionId); };
}
function visible(panel: Panel) {
  return panel.element.isConnected && panel.element.getClientRects().length > 0 && !panel.element.closest('[inert], [aria-hidden="true"], [hidden]');
}
function live(request: SelfUiRequest) {
  if (Date.now() >= request.expiresAt) throw new Error("Authorization expired");
  // No ordinary session control is operated behind a modal, including an
  // issue confirmation, permission card or security override.
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) throw new Error("A dialog is open");
}
export async function operateSelfUi(request: SelfUiRequest): Promise<SelfUiSnapshot> {
  live(request);
  const { getSessionStore, openTarget } = await import("@/lib/sessions");
  if (request.action !== "snapshot" && !request.actions.includes(request.action)) throw new Error("Control not authorized");
  if (request.action === "open-autopilot") {
    const { showPanelTab } = await import("@/lib/panelTab");
    await invoke("self_ui_validate", { id: request.id });
    live(request);
    openTarget({ sessionId: request.sessionId, tabId: request.tabId });
    showPanelTab("branch");
    // Wait only for the authorized session's own panel to mount.
    for (let attempt = 0; attempt < 40; attempt++) {
      live(request);
      const fold = folds.get(request.sessionId);
      if (fold) {
        await invoke("self_ui_validate", { id: request.id });
        live(request);
        flushSync(fold);
        const panel = panels.get(request.sessionId);
        if (panel && visible(panel) && panel.snapshot().tabId === request.tabId) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await invoke("self_ui_validate", { id: request.id });
  live(request);
  const panel = panels.get(request.sessionId);
  if (getSessionStore().selectedSessionId !== request.sessionId || !panel || !visible(panel) || panel.snapshot().tabId !== request.tabId) throw new Error("Authorized session controls are not visible");
  const before = panel.snapshot();
  if (request.action !== "snapshot" && request.action !== "open-autopilot") {
    const control = before.controls.find((control) => control.id === request.action);
    if (!control?.enabled) throw new Error("Control is unavailable");
    await panel.click(request);
  }
  live(request);
  const current = panels.get(request.sessionId);
  if (getSessionStore().selectedSessionId !== request.sessionId || !current || !visible(current) || current.snapshot().tabId !== request.tabId) throw new Error("Session changed during action");
  const snapshot = current.snapshot();
  if (request.action === "toggle-merge" || request.action === "toggle-conflicts") {
    if (snapshot.controls.find((control) => control.id === request.action)?.checked === before.controls.find((control) => control.id === request.action)?.checked) throw new Error("Control did not change");
  }
  if ((request.action === "start-autopilot" || request.action === "adopt-pr") && !snapshot.pipelineId) throw new Error("Autopilot did not start");
  return { ...snapshot, controls: snapshot.controls.map((control) => ({ ...control, enabled: control.enabled && request.actions.includes(control.id) })) };
}
let booted = false;
export async function bootSelfUi() {
  if (booted) return;
  try {
    if (getCurrentWindow().label !== "main") return;
    booted = true;
    await listen<{ id: string }>("self-ui-request", async ({ payload: { id } }) => {
      try {
        const request = await invoke<SelfUiRequest>("self_ui_claim", { id });
        const snapshot = await operateSelfUi(request);
        await invoke("self_ui_reply", { id, snapshot, error: null });
      } catch {
        await invoke("self_ui_reply", { id, snapshot: null, error: "unavailable" }).catch(() => {});
      }
    });
  } catch { booted = false; }
}
