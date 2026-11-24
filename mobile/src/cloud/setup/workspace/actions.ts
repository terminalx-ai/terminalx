import { Alert } from "react-native";
import { CloudApiError, type CloudLifecycle, type CloudWorkspace, type CloudWorkspaceItem } from "../../api";
import type { CloudCatalog } from "../../catalog";
import { resumeFailure } from "../../resume";
import { refusalText } from "../../words";
import type { RowAction } from "../../../ui/row-actions";
import { operationOpen } from "./launch";
import { billingLine, STOP } from "./sentences";

/**
 * Stop, Start and Delete of a cloud workspace (25.06), for whoever the server
 * lets do them: its creator and the organization's owners and admins, whom
 * the list names `manager`. The header's ••• and a long press on the
 * workspace's row in the Cloud tab offer the same actions. Nothing is stopped,
 * started or deleted before the person confirms: Stop and Start ask in an
 * alert, Delete opens its own page.
 */

export interface WorkspaceActionsContext {
  catalog: CloudCatalog;
  /** Opens a page by its href (the Delete page). */
  push(href: string): void;
  /**
   * Whether an agent is in the middle of a turn, and which, when the page
   * knows it from the runtime. Without it the list's activity says whether one is.
   */
  working?: { agent: string | null } | null;
  /** The stop the server accepted, so the page can follow it. */
  onStopping?(lifecycle: CloudLifecycle): void;
}

/** Whether this person may stop, start and delete the workspace (the server would refuse anyone else). */
export function mayManage(workspace: Pick<CloudWorkspace, "you"> | null | undefined): boolean {
  return workspace?.you?.role === "manager";
}

/** The Delete page for a workspace. */
export function deleteHref(workspace: Pick<CloudWorkspace, "orgId" | "id">): string {
  return `/cloud/delete?orgId=${encodeURIComponent(workspace.orgId)}&workspaceId=${encodeURIComponent(workspace.id)}`;
}

/**
 * A workspace's actions in the shape a row's long press and the header's •••
 * take: Stop workspace while it runs, Start workspace while it is stopped,
 * and Delete workspace… (a page, hence the ellipsis). Nothing for someone who
 * may not manage it.
 */
export function workspaceRowActions(item: CloudWorkspaceItem, context: WorkspaceActionsContext): RowAction[] {
  const { workspace } = item;
  if (!mayManage(workspace)) return [];
  const operation = item.latestOperation;
  const busy = operationOpen(operation);
  const actions: RowAction[] = [];
  if (workspace.state === "suspended" && !busy) actions.push({ name: "start-workspace", label: STOP.start, run: () => askToStart(context.catalog, workspace) });
  if ((workspace.state === "ready" || workspace.state === "attention-required") && !(busy && operation?.action === "suspend")) {
    const working = context.working !== undefined ? context.working : (workspace.runtimeActivity?.activeTurns ?? 0) > 0 ? { agent: null } : null;
    actions.push({ name: "stop-workspace", label: STOP.action, run: () => void askToStop(context.catalog, workspace, working, context.onStopping) });
  }
  if (workspace.state !== "deleting" && !(busy && operation?.action === "delete")) actions.push({ name: "delete-workspace", label: STOP.delete, destructive: true, run: () => context.push(deleteHref(workspace)) });
  return actions;
}

/**
 * Asks before stopping: what it does (and that a turn is under way, when one
 * is), then the provider's own billing line from its descriptor. Only the
 * alert's Stop sends the request.
 */
export async function askToStop(catalog: CloudCatalog, workspace: Pick<CloudWorkspace, "orgId" | "id" | "provider" | "providerDescriptor">, working: { agent: string | null } | null, onStopping?: (lifecycle: CloudLifecycle) => void): Promise<void> {
  const described = await catalog.api.providers(workspace.orgId).then((providers) => providers.find((provider) => provider.id === workspace.provider)?.descriptor ?? null, () => null);
  const billing = billingLine(described);
  const said = working ? STOP.working(working.agent) : STOP.message;
  Alert.alert(working ? STOP.workingTitle : STOP.title, billing ? `${said} ${billing}` : said, [
    { text: STOP.cancel, style: "cancel" },
    { text: working ? STOP.confirmWorking : STOP.confirm, style: working ? "destructive" : "default", onPress: () => void stop(catalog, workspace, onStopping) },
  ]);
}

/** Sends the stop the person confirmed; a refusal is said in an alert, in words. */
export async function stop(catalog: CloudCatalog, workspace: Pick<CloudWorkspace, "orgId" | "id">, onStopping?: (lifecycle: CloudLifecycle) => void): Promise<void> {
  try {
    // Sent first, whoever listens: `onStopping?.(await …)` would skip the request when no page follows it.
    const answer = await catalog.api.suspend(workspace.orgId, workspace.id);
    onStopping?.(answer);
  } catch (error) {
    const busy = error instanceof CloudApiError && error.refusal === "workspace-busy";
    Alert.alert(busy ? STOP.busyTitle : STOP.refusedTitle, error instanceof CloudApiError ? refusalText(error) : refusalText("unknown"), [{ text: STOP.ok }]);
  } finally {
    // What the workspace is doing now shows in the list, whatever the answer was.
    void catalog.refresh();
  }
}

/** Start from the sheet, asked as the stopped bar asks (it is billed while it runs). */
export function askToStart(catalog: CloudCatalog, workspace: Pick<CloudWorkspace, "orgId" | "id">): void {
  Alert.alert(STOP.startTitle, STOP.startMessage, [
    { text: STOP.cancel, style: "cancel" },
    { text: STOP.startConfirm, onPress: () => void catalog.start(workspace.orgId, workspace.id).catch((error: unknown) => Alert.alert(STOP.startFailedTitle, resumeFailure(error).text)) },
  ]);
}
