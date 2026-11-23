import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Trash2 } from "lucide-react-native";
import type { CloudOperation } from "@mobile/cloud/api";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { workspaceTitle } from "@mobile/cloud/catalog";
import { DELETE_ACKNOWLEDGE, DELETE_KEEP_WORK, cleanupFacts, deleteFacts, deleteFailure, deleteRefusal, mayManage, outcomeUnknown } from "@mobile/cloud/launch";
import { accessText } from "@mobile/cloud/words";
import { ConsentRow } from "@mobile/ui/ConsentRow";
import { FactRows } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { Button, EmptyState } from "@mobile/ui/primitives";
import { ScreenHeader } from "@mobile/ui/SessionChrome";
import { useTheme } from "@mobile/ui/theme";

/**
 * Delete a cloud workspace (25.06). A page, not an alert: four facts and an
 * acknowledgement do not fit an alert, and a page cannot be confirmed by a
 * stray second tap. The facts and the acknowledgement are the web console's,
 * with the provider's name from the server. Delete permanently is off until
 * the switch is on. On the server's yes the phone returns to the Cloud tab,
 * where the row stays as "Being deleted" until the provider confirms.
 *
 * Opened again after a delete the provider refused, it leads with why, and
 * with the server's cleanup report, so what may still cost money is not hidden.
 */
export default function DeleteWorkspaceScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; orgId: string }>();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const item = snapshot.organizations.find((entry) => entry.organization.orgId === params.orgId)?.workspaces.find((held) => held.workspace.id === params.workspaceId) ?? null;
  const [acknowledged, setAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // One request, also between a tap and the render that locks the buttons.
  const inFlight = useRef(false);

  // A delete that started and did not finish: the full operation carries what was and was not removed.
  const failedId = item?.latestOperation?.action === "delete" && item.latestOperation.state === "failed" ? item.latestOperation.id : null;
  const [report, setReport] = useState<CloudOperation | null>(null);
  useEffect(() => {
    if (!catalog || !failedId) return;
    let current = true;
    catalog.api.operation(params.orgId, failedId).then((answer) => { if (current) setReport(answer.operation); }, () => undefined);
    return () => { current = false; };
  }, [catalog, params.orgId, failedId]);
  // A report is about the delete it was read for, not a later one.
  const failed = report && report.id === failedId ? report : null;

  const back = () => router.back();
  const frame = (body: ReactNode) => <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title: "Delete workspace", headerShown: false }} />
    <ScreenHeader title="Delete workspace" onBack={back} />
    {body}
  </View>;

  if (!catalog) return frame(<EmptyState title="Sign in to manage workspaces" detail="Cloud workspaces belong to your TerminalX account." />);
  if (!item || sent) {
    const gone = accessText("deleted");
    // Sent, or already gone from the list: there is nothing left here to confirm.
    return frame(sent ? <EmptyState busy title="Deleting…" detail="Returning to the Cloud tab." /> : <EmptyState icon={(color) => <Trash2 size={34} color={color} strokeWidth={1.6} />} title={gone.title} detail={gone.detail} />);
  }
  const { workspace } = item;
  if (!mayManage(workspace)) return frame(<EmptyState title="You cannot delete this workspace" detail="Only this workspace's creator or an organization owner or admin can do that." />);

  const title = workspaceTitle(snapshot, workspace);
  const provider = workspace.providerDescriptor?.label ?? workspace.provider;
  const remove = async () => {
    if (inFlight.current || !acknowledged) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(null);
    try {
      await catalog.remove(workspace.orgId, workspace.id);
      // The confirmation is spent: nothing is left to send again while the page goes away.
      setSent(true);
      if (router.canDismiss()) router.dismissAll(); else router.back();
    } catch (error) {
      setRefusal(deleteRefusal(error));
      // With no answer the delete may have started: the list is read, so the row says which.
      if (outcomeUnknown(error)) void catalog.refresh();
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return frame(<>
    <ScrollView contentContainerStyle={styles.content}>
      {failedId ? <>
        <Notice testID="delete-failed" tone="danger" text={deleteFailure(failed ?? { errorCode: item.latestOperation?.errorCode ?? undefined }, provider)} />
        {failed?.cleanup?.items.length ? <>
          <Text accessibilityRole="header" style={[styles.heading, { color: palette.ink }]}>What was removed</Text>
          <FactRows testID="cleanup-report" facts={cleanupFacts(failed.cleanup)} />
          {failed.cleanup.complete ? null : <Text style={[styles.help, { color: palette.muted }]}>{`Until ${provider} confirms, the machine may still be billed.`}</Text>}
        </> : null}
      </> : null}
      <Text testID="delete-title" accessibilityRole="header" style={[styles.title, { color: palette.ink }]}>{`Delete ${title} permanently?`}</Text>
      <FactRows testID="delete-facts" layout="sentences" facts={deleteFacts(provider)} />
      <Text style={[styles.help, { color: palette.muted }]}>{DELETE_KEEP_WORK}</Text>
      <ConsentRow testID="delete-acknowledge" text={DELETE_ACKNOWLEDGE} value={acknowledged} disabled={sending} onValueChange={setAcknowledged} />
    </ScrollView>
    {/* A refusal sits above the buttons, in view however far the facts are scrolled. */}
    <View style={[styles.foot, { paddingBottom: insets.bottom + 12 }]}>
      {refusal ? <Notice testID="delete-refusal" tone="danger" text={refusal} /> : null}
      <Button testID="delete-permanently" label={sending ? "Deleting…" : failedId ? "Delete again" : "Delete permanently"} kind="danger" disabled={!acknowledged || sending} accessibilityState={{ disabled: !acknowledged || sending, busy: sending }} onPress={() => void remove()} />
      <Button label="Cancel" kind="secondary" disabled={sending} onPress={back} />
    </View>
  </>);
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16, gap: 12 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "600", marginHorizontal: 4, marginTop: 4 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "600", marginHorizontal: 4, marginTop: 4 },
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  foot: { paddingHorizontal: 16, paddingTop: 10, gap: 8 },
});
