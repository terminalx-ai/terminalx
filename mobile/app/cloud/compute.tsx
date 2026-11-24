import { StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { CloudOff, ServerOff } from "lucide-react-native";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { COMPUTE_INTRO, COMPUTE_OWNER_REQUIRED, computeProviderHref, keyStored, listFailure, managesCompute } from "@mobile/cloud/compute";
import { TitleWithOrganization, useProviders } from "@mobile/ui/compute";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, EmptyState, Screen } from "@mobile/ui/primitives";
import { ProviderRow } from "@mobile/ui/ProviderRow";
import { providerBadge } from "@mobile/ui/StateBadge";
import { useTheme } from "@mobile/ui/theme";

/**
 * An organization's compute providers (25.03): whatever the server lists, in
 * its order, each with its name, mark, description, billing line and state.
 * There is no list of providers in the app. Someone who manages compute opens
 * a provider to connect, replace or disconnect its key; a member sees whether
 * each can be used and who to ask.
 */
export default function ComputeScreen() {
  const { orgId } = useLocalSearchParams<{ orgId: string }>();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === orgId)?.organization.name ?? null;
  return <>
    <Stack.Screen options={{ title: "Compute", headerLargeTitle: false, headerTitle: () => <TitleWithOrganization title="Compute" organization={organization} /> }} />
    {catalog && orgId ? <Providers catalog={catalog} orgId={orgId} /> : <EmptyState title="Compute unavailable" detail="Sign in, then open the organization again." />}
  </>;
}

function Providers({ catalog, orgId }: { catalog: CloudCatalog; orgId: string }) {
  const { palette } = useTheme();
  const router = useRouter();
  const { providers, error, reading, read } = useProviders(catalog, orgId);

  if (!providers) {
    if (error) {
      const failure = listFailure(error);
      return <Screen testID="compute-failed">
        <EmptyState title={failure.title} detail={failure.detail} icon={(color) => <CloudOff size={30} color={color} />} />
        <View style={styles.retry}><Button label="Try again" kind="secondary" disabled={reading} onPress={() => void read()} /></View>
      </Screen>;
    }
    // Rows in the list's shape while it is read.
    return <Screen testID="compute-reading">
      <Text style={[styles.intro, { color: palette.muted }]}>{COMPUTE_INTRO}</Text>
      <Card accessible accessibilityLabel="Reading the providers" accessibilityState={{ busy: true }}>
        {[58, 44].map((width, index) => <View key={width} style={[styles.placeholder, index ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null]}>
          <View style={[styles.placeholderMark, { backgroundColor: palette.raised }]} />
          <View style={styles.placeholderBody}>
            <View style={[styles.bar, { width: `${width}%`, backgroundColor: palette.raised }]} />
            <View style={[styles.bar, styles.barFaint, { backgroundColor: palette.raised }]} />
          </View>
        </View>)}
      </Card>
    </Screen>;
  }

  if (!providers.length) return <Screen testID="compute-empty">
    <EmptyState title="No providers are offered" detail="Your account service offers no compute provider to this organization right now." icon={(color) => <ServerOff size={30} color={color} />} />
  </Screen>;

  const manages = managesCompute(providers);
  return <Screen testID="compute-list">
    {manages
      ? <Text style={[styles.intro, { color: palette.muted }]}>{COMPUTE_INTRO}</Text>
      : <Notice testID="compute-owner-required" tone="info" text={COMPUTE_OWNER_REQUIRED} />}
    {/* What is shown is the last answer; a read that failed since says so. */}
    {error ? <Notice testID="compute-stale" tone="warning" text={`${listFailure(error).detail} What is shown may be out of date.`} action={{ label: "Try again", disabled: reading, onPress: () => void read() }} /> : null}
    <Card>
      {providers.map((provider, index) => <ProviderRow
        key={provider.id}
        testID={`provider-${provider.id}`}
        name={provider.descriptor.label}
        description={provider.descriptor.description}
        billing={provider.descriptor.billing}
        icon={provider.descriptor.icon}
        badge={providerBadge(provider)}
        divided={index > 0}
        // The server sends a member no connection to look at: no row opens.
        onPress={provider.canManage ? () => router.push(computeProviderHref(orgId, provider.id)) : undefined}
      />)}
    </Card>
    {manages && providers.some(keyStored) ? <Text style={[styles.help, { color: palette.muted }]}>One provider is enough. A workspace picks its provider when it is launched.</Text> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  intro: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  help: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
  retry: { paddingHorizontal: 8 },
  placeholder: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14 },
  placeholderMark: { width: 32, height: 32, borderRadius: 9 },
  placeholderBody: { flex: 1, gap: 9 },
  bar: { height: 10, borderRadius: 5 },
  barFaint: { width: "80%", opacity: 0.6 },
});
