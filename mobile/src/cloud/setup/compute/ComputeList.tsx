import { StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { CloudOff, ServerOff } from "lucide-react-native";
import type { CloudProvider } from "@mobile/cloud/api";
import { useCloudApi, useRead } from "@mobile/cloud/setup/read";
import { refusalText } from "@mobile/cloud/words";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { ProviderRow } from "@mobile/ui/ProviderRow";
import { providerBadge } from "@mobile/ui/StateBadge";
import { useTheme } from "@mobile/ui/theme";
import { managesCompute, oneConnected, opens } from "./model";
import { Helper, HeaderTitle, Page, useOrganizationName } from "./parts";
import { INTRO, listFailure, MEMBER, NONE_OFFERED, ONE_IS_ENOUGH, READING_LABEL, UNREADABLE_TITLE } from "./words";

const TITLE = "Compute";

/**
 * Step 2 of setup (board 25.03): the compute providers the server offers this
 * organization, in its order, each with its own name, mark, description,
 * billing line and state. Someone who manages compute opens a provider to
 * connect it; a member is told who can, and no row opens.
 */
export function ComputeList({ orgId }: { orgId: string }) {
  const api = useCloudApi();
  const organization = useOrganizationName(orgId);
  const router = useRouter();
  const list = useRead((client) => client.providers(orgId), [orgId], { refreshOnFocus: true });
  const header = <Stack.Screen options={{ title: TITLE, headerLargeTitle: false, headerTitle: () => <HeaderTitle title={TITLE} subtitle={organization} /> }} />;

  if (!api) return <>{header}<EmptyState title="Compute unavailable" detail={refusalText("signed-out")} /></>;

  const providers = list.value;
  if (providers === null) {
    if (list.state === "could-not-be-read") return <>{header}<Page testID="compute-unreadable">
      <View style={styles.gap} />
      <EmptyState title={UNREADABLE_TITLE} detail={listFailure(list.error)} icon={(color) => <CloudOff size={30} color={color} />} />
      <View style={styles.retry}><Button label="Try again" kind="secondary" disabled={list.refreshing} onPress={() => void list.refresh()} /></View>
    </Page></>;
    return <>{header}<Page testID="compute-reading">
      <Intro />
      <Placeholders />
    </Page></>;
  }

  if (providers.length === 0) return <>{header}<Page testID="compute-none-offered">
    <View style={styles.gap} />
    <EmptyState title={NONE_OFFERED.title} detail={NONE_OFFERED.detail} icon={(color) => <ServerOff size={30} color={color} />} />
  </Page></>;

  const manager = managesCompute(providers);
  const open = (provider: CloudProvider) => router.push(`/cloud/compute/${encodeURIComponent(provider.id)}?orgId=${encodeURIComponent(orgId)}`);
  return <>{header}<Page testID="compute-list">
    {manager ? <Intro /> : <Notice tone="info" text={MEMBER} testID="compute-member" />}
    {list.state === "could-not-be-read" ? <Notice tone="danger" text={listFailure(list.error)} testID="compute-refresh-failed" /> : null}
    <Card style={styles.card}>
      {providers.map((provider, index) => <ProviderRow
        key={provider.id}
        testID={`compute-provider-${provider.id}`}
        name={provider.displayName || provider.descriptor.label}
        description={provider.descriptor.description}
        billing={provider.descriptor.billing}
        icon={provider.descriptor.icon}
        badge={providerBadge(provider)}
        divided={index > 0}
        onPress={opens(provider) ? () => open(provider) : undefined}
      />)}
    </Card>
    {manager && oneConnected(providers) ? <Helper>{ONE_IS_ENOUGH}</Helper> : null}
  </Page></>;
}

function Intro() {
  const { palette } = useTheme();
  return <Text testID="compute-intro" style={[styles.introText, { color: palette.ink }]}>{INTRO}</Text>;
}

/** Rows in the list's shape while it is read, as the Cloud tab draws its own. */
function Placeholders() {
  const { palette } = useTheme();
  return <View accessible accessibilityLabel={READING_LABEL} accessibilityRole="progressbar" testID="compute-placeholders" style={[styles.placeholders, { backgroundColor: palette.card, borderColor: palette.border }]}>
    {[62, 48].map((width, index) => <View key={index} style={[styles.placeholderRow, index > 0 ? { borderTopColor: palette.border, borderTopWidth: StyleSheet.hairlineWidth } : null]}>
      <View style={[styles.placeholderMark, { backgroundColor: palette.raised }]} />
      <View style={styles.placeholderBody}>
        <View style={[styles.bar, { backgroundColor: palette.raised, width: `${width}%` }]} />
        <View style={[styles.bar, styles.barLine, { backgroundColor: palette.raised }]} />
      </View>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  introText: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  card: { overflow: "hidden" },
  gap: { height: 48 },
  retry: { marginTop: 20, marginHorizontal: 8 },
  placeholders: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  placeholderRow: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  placeholderMark: { width: 32, height: 32, borderRadius: 9 },
  placeholderBody: { flex: 1, gap: 10 },
  bar: { height: 10, borderRadius: 5 },
  barLine: { width: "82%", opacity: 0.6 },
});
