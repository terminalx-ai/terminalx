import { useCallback, useMemo } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import type { CloudWorkspaceItem } from "@mobile/cloud/api";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { codeText, roleLabel, stateLabel } from "@mobile/cloud/words";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, StatusDot } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The account's cloud workspaces, by organization. This screen only reads the
 * list: opening it, pulling to refresh and coming back to it start nothing.
 */
export default function CloudScreen() {
  const app = useApp();
  const { palette } = useTheme();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);

  useFocusEffect(useCallback(() => { void catalog?.refresh(); }, [catalog]));

  const sections = useMemo(() => snapshot.organizations.map((entry) => ({ key: entry.organization.orgId, title: entry.organization.name, error: entry.error, loaded: entry.loaded, data: entry.workspaces })), [snapshot.organizations]);

  if (!app.session) return <View style={[styles.page, { backgroundColor: palette.page }]}><EmptyState title="Sign in for cloud workspaces" detail="Cloud workspaces belong to your TerminalX account." /><Button label="Sign in" onPress={() => void app.signIn()} /></View>;

  return <SectionList sections={sections} keyExtractor={(item) => item.workspace.id} automaticallyAdjustContentInsets contentInsetAdjustmentBehavior="automatic" stickySectionHeadersEnabled={false} style={{ backgroundColor: palette.page }} contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={snapshot.loading} onRefresh={() => void catalog?.refresh()} tintColor={palette.accent} />}
    ListHeaderComponent={snapshot.error ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.warning }]}>{codeText(snapshot.error)}</Text> : null}
    renderSectionHeader={({ section }) => <View style={styles.sectionHeader}><Text numberOfLines={1} style={[styles.sectionTitle, { color: palette.ink }]}>{section.title}</Text>{section.error ? <Text style={[styles.notice, { color: palette.warning }]}>{codeText(section.error)}</Text> : null}</View>}
    renderSectionFooter={({ section }) => section.data.length === 0 && section.loaded && !section.error ? <Text style={[styles.empty, { color: palette.muted }]}>No cloud workspaces you can see.</Text> : null}
    renderItem={({ item }) => <WorkspaceRow item={item} onPress={() => router.push({ pathname: "/cloud/[workspaceId]", params: { workspaceId: item.workspace.id, orgId: item.workspace.orgId, title: item.workspace.name } })} />}
    ListEmptyComponent={snapshot.loading || !snapshot.refreshedAt ? <EmptyState title="Loading cloud workspaces" detail="Reading the list from your account." busy /> : <EmptyState title="No organizations" detail="Cloud workspaces of your organizations appear here." />} />;
}

function WorkspaceRow({ item, onPress }: { item: CloudWorkspaceItem; onPress(): void }) {
  const { palette } = useTheme();
  const { workspace } = item;
  const running = workspace.state === "ready";
  const waiting = workspace.runtimeActivity?.pendingApprovals ?? 0;
  const working = running && (workspace.runtimeActivity?.activeTurns ?? 0) > 0;
  const color = workspace.state === "attention-required" ? palette.danger : waiting > 0 ? palette.warning : running ? palette.success : palette.faint;
  const role = roleLabel(workspace.you?.role);
  const repository = workspace.repositories?.find((entry) => entry.primary)?.fullName ?? workspace.repositories?.[0]?.fullName ?? null;
  const facts = [stateLabel(workspace.state), waiting > 0 ? `${waiting} waiting for an answer` : working ? "Working" : null, role === "Manager" ? null : role, workspace.sharedWith ? `Shared with ${workspace.sharedWith}` : null].filter(Boolean);
  return <Card style={styles.card}><Pressable accessibilityRole="button" accessibilityLabel={`${workspace.name}, ${facts.join(", ")}`} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.raised }]}>
    <StatusDot color={color} />
    <View style={styles.flex}>
      <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{workspace.name}</Text>
      {repository ? <Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{repository}{workspace.launch?.workBranch ? ` · ${workspace.launch.workBranch}` : ""}</Text> : null}
      <Text numberOfLines={2} style={[styles.meta, { color: waiting > 0 ? palette.warning : palette.muted }]}>{facts.join(" · ")}</Text>
    </View>
    <ChevronRight size={18} color={palette.faint} />
  </Pressable></Card>;
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, justifyContent: "center", gap: 12 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 36, gap: 9 },
  sectionHeader: { marginTop: 12, marginBottom: 2, paddingHorizontal: 3, gap: 3 },
  sectionTitle: { fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  notice: { fontSize: 13, lineHeight: 18 },
  empty: { fontSize: 14, paddingHorizontal: 3, paddingVertical: 8 },
  card: { marginBottom: 1 },
  row: { minHeight: 68, padding: 14, flexDirection: "row", gap: 12, alignItems: "center" },
  flex: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: "700" },
  meta: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
