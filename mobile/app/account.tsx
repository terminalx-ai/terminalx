import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { organizationRoleName } from "@mobile/cloud/words";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, SectionTitle } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/**
 * The TerminalX account this phone is signed in to, opened from its row at
 * the top of Settings (22.05). Signing out is here, one step away from a
 * stray tap. Each organization of the account opens its own page (#1292).
 */
export default function AccountScreen() {
  const app = useApp();
  const router = useRouter();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const organizations = useCatalogSnapshot(useCloudCatalog()).organizations.map((entry) => entry.organization);
  const user = app.session?.user;
  const signOut = async () => {
    await app.signOut();
    router.back();
  };
  return <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: palette.page }} contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}>
    {user ? <>
      <Card style={styles.block}>
        <Text style={[styles.label, { color: palette.muted }]}>Signed in as</Text>
        {user.displayName ? <Text selectable style={[styles.name, { color: palette.ink }]}>{user.displayName}</Text> : null}
        <Text selectable style={[styles.detail, { color: palette.muted }]}>{user.email}</Text>
      </Card>
      {organizations.length ? <>
        <SectionTitle>Organizations</SectionTitle>
        <Card>{organizations.map((organization, index) =>
          <Pressable key={organization.orgId} accessibilityRole="button" accessibilityLabel={`${organization.name}, ${organizationRoleName(organization.role)}`}
            onPress={() => router.push({ pathname: "/organization/[orgId]", params: { orgId: organization.orgId } })}
            style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.raised }]}>
            <View style={styles.flex}>
              <Text numberOfLines={1} style={[styles.rowName, { color: palette.ink }]}>{organization.name}</Text>
              <Text style={[styles.detail, { color: palette.muted }]}>{organization.isPersonal ? `Personal · ${organizationRoleName(organization.role)}` : organizationRoleName(organization.role)}</Text>
            </View>
            <ChevronRight size={18} color={palette.faint} />
          </Pressable>)}</Card>
      </> : null}
      <Text style={[styles.note, { color: palette.muted }]}>Signing out removes the machines this phone paired through your account, and the conversations it saved. Machines you paired with a QR code stay.</Text>
      <Button label="Sign out" kind="danger" onPress={() => void signOut()} />
    </> : <View style={styles.block}>
      <Text style={[styles.detail, { color: palette.muted }]}>Not signed in.</Text>
      <Button label="Sign in" onPress={() => void app.signIn()} />
    </View>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14 },
  block: { padding: 16, gap: 4 },
  label: { fontSize: 13 },
  name: { fontSize: 17, fontWeight: "600" },
  detail: { fontSize: 15, lineHeight: 21 },
  row: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12 },
  rowName: { fontSize: 16 },
  flex: { flex: 1 },
  note: { fontSize: 13, lineHeight: 18, marginHorizontal: 4 },
});
