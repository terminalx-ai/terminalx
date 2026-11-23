import { Alert } from "react-native";
import { CloudApiError, type CloudProvider, type CloudWorkspaceItem } from "@mobile/cloud/api";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { launchRefusal, mayManage, stopQuestion, stopState } from "@mobile/cloud/launch";
import { resumeFailure } from "@mobile/cloud/resume";
import type { RowAction } from "./row-actions";

/**
 * What a workspace's manager can do to it from its header's ••• and from a
 * long press on its row (25.06): stop it, start it, delete it. Offered to
 * whoever the server lets do them (the workspace's creator and the
 * organization's owners and admins); for anyone else there is nothing, and
 * the server would refuse them anyway.
 *
 * Stop asks first: the tap is small and its effect is not. Delete opens its
 * own page (`openDelete`), which is where it is confirmed.
 */
export function workspaceActions({ catalog, item, openDelete }: { catalog: CloudCatalog | null; item: CloudWorkspaceItem | null | undefined; openDelete(): void }): RowAction[] {
  if (!catalog || !item || !mayManage(item.workspace)) return [];
  const { workspace } = item;
  const { orgId, id } = workspace;
  const stopping = stopState(workspace, item.latestOperation);
  const actions: RowAction[] = [];

  const refused = (title: string, error: unknown) => {
    const busy = error instanceof CloudApiError && error.refusal === "workspace-busy";
    Alert.alert(busy ? "Not right now" : title, launchRefusal(error).text, [{ text: "OK" }]);
  };
  const stop = () => void catalog.stop(orgId, id).catch((error: unknown) => refused("The workspace was not stopped", error));
  const askStop = async () => {
    // The provider's own billing line is quoted in the question; without it the question still asks.
    const providers = await catalog.api.providers(orgId).catch(() => [] as CloudProvider[]);
    const working = (catalog.workspace(orgId, id)?.runtimeActivity?.activeTurns ?? 0) > 0;
    const { title, message } = stopQuestion(providers.find((provider) => provider.id === workspace.provider) ?? null, working);
    Alert.alert(title, message, working
      ? [{ text: "Stop anyway", style: "destructive", onPress: stop }, { text: "Cancel", style: "cancel" }]
      : [{ text: "Cancel", style: "cancel" }, { text: "Stop", onPress: stop }]);
  };
  const askStart = () => Alert.alert("Start this workspace?", "It is billed to the organization while it runs.", [
    { text: "Cancel", style: "cancel" },
    { text: "Start", onPress: () => void catalog.start(orgId, id).catch((error: unknown) => Alert.alert("The workspace did not start", resumeFailure(error).text, [{ text: "OK" }])) },
  ]);

  if (stopping === "failed") actions.push({ name: "stop", label: "Retry stop", run: stop });
  else if (workspace.state === "ready" && !stopping) actions.push({ name: "stop", label: "Stop workspace", run: () => void askStop() });
  else if (workspace.state === "suspended") actions.push({ name: "start", label: "Start workspace", run: askStart });
  if (workspace.state !== "deleting") actions.push({ name: "delete", label: "Delete workspace…", destructive: true, run: openDelete });
  return actions;
}
