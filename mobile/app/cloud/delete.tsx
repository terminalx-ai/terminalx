import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { workspaceTitle } from "@mobile/cloud/catalog";
import { CloudApiError } from "@mobile/cloud/api";
import { accessText, refusalText } from "@mobile/cloud/words";
import { useProvider } from "@mobile/cloud/setup/workspace/hooks";
import { DELETE } from "@mobile/cloud/setup/workspace/sentences";
import { ConsentRow } from "@mobile/ui/ConsentRow";
import { FactRows } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { Button, EmptyState } from "@mobile/ui/primitives";
import { Spinner } from "@mobile/ui/Spinner";
import { useTheme } from "@mobile/ui/theme";

/**
 * Deleting a cloud workspace (25.06): a page, not an alert, so it cannot be
 * confirmed by a stray second tap. The facts and the acknowledgement are the
 * web console's, with the provider's name from the server. Delete permanently
 * stays off until the switch is on; on the server's yes the phone goes back to
 * the Cloud tab, where the row says it is being deleted until the provider
 * confirms. A refusal sits above the buttons, and nothing was deleted.
 */
export default function DeleteWorkspaceScreen() {
  const params = useLocalSearchParams<{ orgId?: string; workspaceId?: string }>();
  const orgId = params.orgId ?? null;
  const workspaceId = params.workspaceId ?? null;
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const workspace = catalog && orgId && workspaceId ? catalog.workspace(orgId, workspaceId) : null;
  const access = catalog && orgId && workspaceId ? catalog.access(orgId, workspaceId) : "unknown";
  const provider = useProvider(orgId, workspace?.provider ?? null, workspace?.providerDescriptor?.label);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // One request at a time, also between a tap and the render that locks the buttons.
  const inFlight = useRef(false);

  const screen = <Stack.Screen options={{ title: DELETE.pageTitle, headerLargeTitle: false, headerBackButtonDisplayMode: "minimal" }} />;
  if (!catalog) return <View style={[styles.page, { backgroundColor: palette.page }]}>{screen}<EmptyState title={DELETE.unavailable} detail={DELETE.unavailableDetail} /></View>;
  if (!workspace || !orgId || !workspaceId) {
    const closed = access === "deleted" || access === "gone" || access === "not-shared" ? accessText(access) : null;
    return <View style={[styles.page, { backgroundColor: palette.page }]}>{screen}{closed ? <EmptyState title={closed.title} detail={closed.detail} /> : <EmptyState title={DELETE.reading} detail={DELETE.readingDetail} busy />}</View>;
  }

  const name = workspaceTitle(snapshot, workspace);
  const providerName = provider?.label ?? DELETE.someProvider;
  const done = () => { void catalog.refresh(); router.dismissTo("/cloud"); };
  const remove = async () => {
    if (!acknowledged || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setRefusal(null);
    try {
      await catalog.api.deleteWorkspace(orgId, workspaceId);
      done();
    } catch (error) {
      if (!(error instanceof CloudApiError)) throw error;
      if (error.reason === "timeout") {
        // No answer in time: the server may have acted. The list says whether it is being deleted.
        const read = await catalog.fresh(orgId).catch(() => false);
        const now = catalog.workspace(orgId, workspaceId);
        if (read && (!now || now.state === "deleting")) return done();
      }
      setRefusal(error.reason === "network" ? DELETE.offline : refusalText(error));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    {screen}
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={[styles.question, { color: palette.ink }]}>{DELETE.question(name)}</Text>
      <FactRows testID="delete-facts" layout="sentences" facts={DELETE.facts(providerName)} />
      <Text style={[styles.keep, { color: palette.muted }]}>{DELETE.keep}</Text>
      <ConsentRow testID="delete-acknowledge" text={DELETE.acknowledge} value={acknowledged} disabled={sending} onValueChange={setAcknowledged} />
    </ScrollView>
    <View style={[styles.footer, { borderTopColor: palette.border, paddingBottom: insets.bottom + 8 }]}>
      {refusal ? <Notice tone="danger" text={refusal} testID="delete-refusal" /> : null}
      <Button label={sending ? DELETE.sending : DELETE.confirm} kind="danger" disabled={!acknowledged || sending} icon={sending ? (color) => <Spinner size={16} color={color} /> : undefined} onPress={() => void remove()} />
      <Button label={DELETE.cancel} kind="secondary" disabled={sending} onPress={() => router.back()} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 10 },
  question: { fontSize: 22, lineHeight: 28, fontWeight: "700", marginBottom: 4 },
  keep: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10, gap: 8 },
});
