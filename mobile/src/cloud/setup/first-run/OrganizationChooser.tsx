import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Check, ChevronRight, Plus } from "lucide-react-native";
import type { CloudOrganization } from "../../api";
import { useCatalogSnapshot, useCloudCatalog } from "../../CloudProvider";
import { Button, Card, EmptyState } from "../../../ui/primitives";
import { useTheme } from "../../../ui/theme";
import { Intro, Note, Page } from "../logins/parts";
import { useSetupReads } from "./reads";
import { choiceDetail, hrefs, personalFirst } from "./steps";
import * as W from "./words";

/**
 * Step 1 (25.02): which organization is set up. The personal one is chosen
 * already when the server lists one, so one tap carries on; with several,
 * each says the person's role and how far its setup is. "Create an
 * organization" is offered only where the server takes it from the phone;
 * otherwise a line says where a team organization is made. Continue goes
 * back to the Cloud tab with this organization as the one being set up.
 */
export function OrganizationChooser() {
  const params = useLocalSearchParams<{ orgId?: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const organizations = useMemo(() => personalFirst(snapshot.organizations.map((entry) => entry.organization)), [snapshot.organizations]);
  const setup = useSetupReads(catalog, organizations);
  const [picked, setPicked] = useState<string | null>(null);
  const creates = snapshot.createsOrganizations === true;

  const title = <Stack.Screen options={{ title: W.ORGANIZATION_TITLE, headerLargeTitle: false }} />;
  if (!catalog) return <>{title}<EmptyState title="Organization unavailable" detail="Sign in to see your organizations." /></>;
  // Nothing read yet: the list comes with the account's capabilities.
  if (!snapshot.refreshedAt && !snapshot.saved && !snapshot.error) return <>{title}<EmptyState busy title="Reading your organizations" detail="" /></>;

  const chosen = organizations.find((entry) => entry.orgId === (picked ?? params.orgId ?? setup.chosen)) ?? organizations[0] ?? null;
  const alone = organizations.length === 1;
  const createRow = creates ? <CreateRow inline={organizations.length <= 1} onPress={() => router.push(`${hrefs.newOrganization}?from=organization` as never)} /> : null;
  const choose = (organization: CloudOrganization) => {
    setup.choose(organization.orgId);
    router.back();
  };

  return <>
    {title}
    <Page testID="organization-chooser" footer={chosen ? <Button label={chosen.isPersonal ? W.CONTINUE_PERSONAL : W.continueWith(chosen.name)} onPress={() => choose(chosen)} /> : undefined}>
      <Intro>{organizations.length > 1 ? W.CHOOSE_SEVERAL : W.CHOOSE_INTRO}</Intro>
      {organizations.length ? <Card>
        {organizations.map((organization, index) => {
          const selected = organization.orgId === chosen?.orgId;
          const detail = choiceDetail(organization, setup.get(organization.orgId), alone);
          return <Pressable key={organization.orgId} testID={`organization-${organization.orgId}`} accessibilityRole="radio" accessibilityLabel={`${organization.name}, ${detail}`} accessibilityState={{ selected }} onPress={() => setPicked(organization.orgId)}
            style={[styles.row, index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null, selected ? { backgroundColor: palette.raised } : null]}>
            <View style={styles.body}>
              <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{organization.name}</Text>
              <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text>
            </View>
            {selected ? <Check size={16} color={palette.accent} /> : null}
          </Pressable>;
        })}
        {organizations.length === 1 && createRow ? <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }}>{createRow}</View> : null}
      </Card> : null}
      {organizations.length === 1 ? null : createRow ? <Card>{createRow}</Card> : null}
      {creates ? null : <Note>{organizations.length ? W.CREATE_ELSEWHERE : W.CREATE_ELSEWHERE_FIRST}</Note>}
    </Page>
  </>;
}

/** "Create an organization": with what it is for under a single organization, as a + row under several. */
function CreateRow({ inline, onPress }: { inline: boolean; onPress(): void }) {
  const { palette } = useTheme();
  return <Pressable testID="create-organization" accessibilityRole="button" accessibilityLabel={W.CREATE_ROW} onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: palette.raised } : null]}>
    {inline ? null : <Plus size={16} color={palette.muted} />}
    <View style={styles.body}>
      <Text style={[inline ? styles.name : styles.plain, { color: palette.ink }]}>{W.CREATE_ROW}</Text>
      {inline ? <Text style={[styles.detail, { color: palette.muted }]}>{W.CREATE_ROW_DETAIL}</Text> : null}
    </View>
    <ChevronRight size={18} color={palette.faint} />
  </Pressable>;
}

const styles = StyleSheet.create({
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
  plain: { fontSize: 15, lineHeight: 20 },
  detail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
