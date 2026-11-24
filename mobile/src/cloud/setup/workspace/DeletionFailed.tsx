import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CloudOperation } from "../../api";
import { cleanupFacts, deletionRefusal } from "./cleanup";
import { FactRows } from "../../../ui/FactRows";
import { Notice } from "../../../ui/Notice";
import { Button, EmptyState } from "../../../ui/primitives";
import { HeaderLine, ScreenHeader } from "../../../ui/SessionChrome";
import { useTheme } from "../../../ui/theme";
import { DELETE, LAUNCH } from "./sentences";

/**
 * A delete the provider did not confirm (25.06, the last state): the
 * console's sentence, the server's cleanup report in plain words so what may
 * still cost money is not hidden, and Delete again, which opens the Delete page.
 */
export function DeletionFailed({ title, line, operation, provider, actions, onBack, onDeleteAgain }: {
  title: string;
  line: string;
  /** The delete as last read; null while it is read. */
  operation: CloudOperation | null;
  provider: string;
  /** The header's ••• (for someone who may manage it). */
  actions: ReactNode;
  onBack(): void;
  /** Absent for someone who may not delete it. */
  onDeleteAgain?: () => void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const facts = operation ? cleanupFacts(operation) : [];
  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title, headerShown: false }} />
    <ScreenHeader title={title} onBack={onBack} subtitle={<HeaderLine testID="workspace-state-line" text={line} />} trailing={actions} />
    {!operation ? <EmptyState title={LAUNCH.reading} detail={LAUNCH.readingDetail} busy />
      : <>
        <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
          <Notice tone="danger" text={deletionRefusal(operation, provider)} testID="delete-refused" />
          {facts.length ? <>
            <Text accessibilityRole="header" style={[styles.heading, { color: palette.ink }]}>{DELETE.removedHeading}</Text>
            <FactRows testID="cleanup-report" facts={facts} />
          </> : null}
          <Text style={[styles.note, { color: palette.muted }]}>{DELETE.billed(provider)}</Text>
        </ScrollView>
        {onDeleteAgain ? <View style={[styles.footer, { borderTopColor: palette.border, paddingBottom: insets.bottom + 8 }]}>
          <Button label={DELETE.again} kind="danger" onPress={onDeleteAgain} />
        </View> : null}
      </>}
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, gap: 10 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "700", marginTop: 6 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10, gap: 8 },
});
