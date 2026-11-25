import { useCallback } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { SETUP_TEXT, setupView, type SetupStepKey } from "@mobile/cloud/setup";
import { useSetupChoice } from "@mobile/cloud/setup-choice";
import { stepHref, useSetupPages, withPages } from "@mobile/cloud/setup-routes";
import { useOrganizationSetups } from "@mobile/cloud/useSetup";
import { codeText } from "@mobile/cloud/words";
import { useApp } from "@mobile/state/AppProvider";
import { NoComputeCard, SetupCard } from "@mobile/ui/CloudSetup";
import { Notice } from "@mobile/ui/Notice";
import { EmptyState, SectionTitle } from "@mobile/ui/primitives";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { useTheme } from "@mobile/ui/theme";

/**
 * The steps of the organization being set up, on a page of their own (25.01):
 * opened from its folded row on the Cloud tab, once other organizations have
 * workspaces and the tab is their list. The same card, read the same way.
 * The row says which organization (`orgId`): the one this phone chose, one
 * whose setup the server holds (PRO-569), or one picked from the
 * organizations with no workspaces (PRO-561). Opened with none, it is the
 * one this phone chose.
 */
export default function SetupStepsScreen() {
  const app = useApp();
  const router = useRouter();
  const pages = useSetupPages();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ orgId?: string }>();
  const choice = useSetupChoice(app.ready === false ? undefined : app.session?.user.userId ?? null);
  const { store, setups } = useOrganizationSetups(catalog);
  const wanted = params.orgId ?? choice.orgId;
  const organization = snapshot.organizations.find((entry) => entry.organization.orgId === wanted)?.organization ?? null;
  const orgId = wanted && snapshot.organizations.some((entry) => entry.organization.orgId === wanted) ? wanted : null;
  const read = useCallback(() => Promise.all([catalog?.refresh(), orgId ? store?.read(orgId) : undefined]), [catalog, orgId, store]);
  useFocusEffect(useCallback(() => { void read(); }, [read]));
  const pull = usePullRefresh(read);
  const view = organization ? withPages(setupView(organization, true, setups.get(organization.orgId)), pages) : null;
  const offline = snapshot.error === "cloud_workspace_unavailable" || !!view?.stale;
  return <>
    <Stack.Screen options={{ title: SETUP_TEXT.folded, headerLargeTitle: false, headerBackTitle: "Cloud" }} />
    {organization && view ? <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} />}>
      {snapshot.error ? <Notice tone="warning" text={codeText(snapshot.error) ?? undefined} /> : null}
      <SectionTitle>{organization.name}</SectionTitle>
      <View>{view.noCompute ? <NoComputeCard name={organization.name} /> : <SetupCard testID="setup-card" view={view} offline={offline} onOpen={(step: SetupStepKey) => router.push(stepHref(step, organization.orgId))} />}</View>
    </ScrollView> : <EmptyState title="No organization is being set up" detail={catalog ? "Go back to the Cloud tab to start." : "Sign in to set up cloud workspaces."} />}
  </>;
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingTop: 4, gap: 8 },
});
