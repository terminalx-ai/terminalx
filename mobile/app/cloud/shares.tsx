import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import type { CloudMember, CloudShare, CloudShares } from "@mobile/cloud/api";
import { useCloudCatalog } from "@mobile/cloud/CloudProvider";
import type { CloudCatalog } from "@mobile/cloud/catalog";
import { codeText } from "@mobile/cloud/words";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, Screen, SectionTitle } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * Who a cloud workspace is shared with. Everyone it is shared with can read
 * the list; managers and the workspace's creator can add people, change a
 * role or the right to approve permissions, and remove someone. The server
 * decides who may do what on every call; this screen shows what it says.
 * Nothing here starts the workspace.
 */
export default function CloudSharesScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; orgId: string }>();
  const catalog = useCloudCatalog();
  return <>
    <Stack.Screen options={{ title: "Sharing" }} />
    {catalog && params.orgId ? <Shares catalog={catalog} orgId={params.orgId} workspaceId={params.workspaceId} /> : <EmptyState title="Sharing unavailable" detail="Sign in, then open the workspace again." />}
  </>;
}

interface Read {
  state: CloudShares | null;
  members: CloudMember[] | null;
  failure: string | null;
  rosterFailure: string | null;
}

const explain = (error: unknown) => codeText(typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null) ?? "That did not work.";

function Shares({ catalog, orgId, workspaceId }: { catalog: CloudCatalog; orgId: string; workspaceId: string }) {
  const { palette } = useTheme();
  useSyncExternalStore(catalog.people.subscribe, catalog.people.getVersion, catalog.people.getVersion);
  const [view, setView] = useState<Read>({ state: null, members: null, failure: null, rosterFailure: null });
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { state, members, rosterFailure } = view;
  const selfId = useApp().session?.user.userId ?? null;

  /** What the server says now; what was shown stays when it cannot be read. */
  const read = useCallback(async (): Promise<Partial<Read>> => {
    try {
      const next = await catalog.api.shares(orgId, workspaceId);
      catalog.people.remember(next.shares);
      if (!next.you.canManageShares) return { state: next, failure: null };
      try {
        return { state: next, failure: null, members: await catalog.people.roster(orgId), rosterFailure: null };
      } catch (error) {
        return { state: next, failure: null, rosterFailure: explain(error) };
      }
    } catch (error) {
      return { failure: explain(error) };
    }
  }, [catalog, orgId, workspaceId]);

  const load = useCallback(async () => {
    const next = await read();
    setView((before) => ({ ...before, ...next }));
    setFailure(next.failure ?? null);
  }, [read]);

  useEffect(() => {
    let current = true;
    void read().then((next) => {
      if (!current) return;
      setView((before) => ({ ...before, ...next }));
      setFailure(next.failure ?? null);
    });
    return () => { current = false; };
  }, [read]);

  const change = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setFailure(null);
    try {
      await action();
      // The server's list is what is shown, not what was asked for.
      await load();
      // The list of workspaces carries "shared with N".
      void catalog.refresh();
    } catch (error) {
      setFailure(explain(error));
    } finally {
      setBusy(null);
    }
  };

  const put = (share: Pick<CloudShare, "userId">, next: { role: "viewer" | "driver"; canApprove: boolean }) => change(share.userId, () => catalog.api.putShare(orgId, workspaceId, share.userId, next));
  const remove = (share: CloudShare) => Alert.alert(`Remove ${catalog.people.name(share.userId)}?`, "They lose access to this workspace at once, on every device.", [
    { text: "Cancel", style: "cancel" },
    { text: "Remove", style: "destructive", onPress: () => void change(share.userId, () => catalog.api.revokeShare(orgId, workspaceId, share.userId)) },
  ]);

  if (!state) return <Screen>{failure ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.danger }]}>{failure}</Text> : <EmptyState title="Loading" detail="Reading who this workspace is shared with." busy />}{failure ? <Button label="Try again" kind="secondary" onPress={() => void load()} /> : null}</Screen>;

  const manage = state.you.canManageShares;
  const sharedIds = new Set(state.shares.map((share) => share.userId));
  const candidates = (members ?? []).filter((member) => !sharedIds.has(member.userId) && member.userId !== selfId);

  return <Screen>
    {failure ? <Text accessibilityRole="alert" style={[styles.notice, { color: palette.danger }]}>{failure}</Text> : null}
    <SectionTitle>Shared with</SectionTitle>
    {state.shares.length === 0 ? <Text style={[styles.notice, { color: palette.muted }]}>This workspace is not shared with anyone yet.</Text> : null}
    {state.shares.map((share) => <Card key={share.userId} style={styles.card}>
      <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{catalog.people.name(share.userId)}</Text>
      <Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{share.email}</Text>
      {manage ? <>
        <View style={styles.roles}>{(["viewer", "driver"] as const).map((role) => <Pressable key={role} accessibilityRole="button" accessibilityLabel={`${catalog.people.name(share.userId)}: ${role === "viewer" ? "View only" : "Can send"}`} accessibilityState={{ selected: share.role === role }} disabled={busy !== null || share.role === role} onPress={() => void put(share, { role, canApprove: role === "viewer" ? false : share.canApprove })} style={[styles.role, { backgroundColor: share.role === role ? palette.selected : palette.raised }]}><Text style={[styles.roleText, { color: palette.ink }]}>{role === "viewer" ? "View only" : "Can send"}</Text></Pressable>)}</View>
        <View style={styles.approve}>
          <Text style={[styles.meta, styles.flex, { color: palette.ink }]}>Can approve permissions</Text>
          <Switch accessibilityLabel={`${catalog.people.name(share.userId)}: can approve permissions`} value={share.canApprove} disabled={busy !== null || share.role === "viewer"} onValueChange={(value) => void put(share, { role: share.role, canApprove: value })} />
        </View>
        {share.role === "viewer" ? <Text style={[styles.hint, { color: palette.muted }]}>Someone who only views cannot approve.</Text> : null}
        <Button label="Remove" kind="danger" disabled={busy !== null} onPress={() => remove(share)} />
      </> : <Text style={[styles.meta, { color: palette.muted }]}>{share.role === "viewer" ? "View only" : "Can send"}{share.canApprove ? " · can approve permissions" : ""}</Text>}
    </Card>)}
    {manage ? <>
      <SectionTitle>Add someone</SectionTitle>
      {rosterFailure ? <Text style={[styles.notice, { color: palette.warning }]}>{`The organization's members could not be read. ${rosterFailure}`}</Text> : null}
      {members && candidates.length === 0 ? <Text style={[styles.notice, { color: palette.muted }]}>Everyone in the organization already has access.</Text> : null}
      {candidates.map((member) => <Card key={member.userId} style={styles.card}>
        <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{member.displayName?.trim() || member.email}</Text>
        <Text numberOfLines={1} style={[styles.meta, { color: palette.muted }]}>{member.email}</Text>
        <View style={styles.roles}>
          <Button label="Add: view only" kind="secondary" disabled={busy !== null} onPress={() => void put(member, { role: "viewer", canApprove: false })} style={styles.flex} />
          <Button label="Add: can send" kind="secondary" disabled={busy !== null} onPress={() => void put(member, { role: "driver", canApprove: false })} style={styles.flex} />
        </View>
      </Card>)}
    </> : <Text style={[styles.notice, { color: palette.muted }]}>{"Only managers and the workspace's creator can change who it is shared with."}</Text>}
  </Screen>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  notice: { fontSize: 13, lineHeight: 18, paddingHorizontal: 3 },
  card: { padding: 14, gap: 8 },
  name: { fontSize: 16, fontWeight: "700" },
  meta: { fontSize: 13, lineHeight: 18 },
  hint: { fontSize: 12, lineHeight: 17 },
  roles: { flexDirection: "row", gap: 8 },
  role: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  roleText: { fontSize: 14, fontWeight: "600" },
  approve: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
});
