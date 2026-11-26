import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import * as Crypto from "expo-crypto";
import { Stack, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CloudApiError, ORGANIZATION_NAME } from "@mobile/cloud/api";
import { useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { chooseSetupOrganization } from "@mobile/cloud/setup-choice";
import { codeText } from "@mobile/cloud/words";
import { useApp } from "@mobile/state/AppProvider";
import { useKeyboardShown, keyboardAvoidingBehavior } from "@mobile/ui/keyboard";
import { Notice } from "@mobile/ui/Notice";
import { Button, EmptyState } from "@mobile/ui/primitives";
import { Spinner } from "@mobile/ui/Spinner";
import { TextField } from "@mobile/ui/TextField";
import { useTheme } from "@mobile/ui/theme";

export const NEW_ORGANIZATION_TEXT = {
  label: "Organization name",
  helper: `${ORGANIZATION_NAME.min} to ${ORGANIZATION_NAME.max} characters. You can invite people after it is set up.`,
  length: `Use ${ORGANIZATION_NAME.min} to ${ORGANIZATION_NAME.max} characters.`,
  create: "Create organization",
  creating: "Creating…",
  unreachable: "The organization was not created. Check your connection and try again.",
  signedOut: "Sign in again to create an organization.",
} as const;

/**
 * A creation that was sent and not yet answered with a yes or a no. Asking
 * again for the same name sends the same key, so a request that did arrive
 * never makes a second organization; it is kept while the app runs, also
 * when the person leaves the page and comes back. Another name is another
 * request, with a key of its own.
 */
let unanswered: { userId: string; name: string; key: string } | null = null;
/** For tests: as a freshly started app. */
export function resetCreationForTests(): void { unanswered = null; }

/**
 * Create an organization for a team (25.02): one field, its name. The
 * creator becomes its owner, and it becomes the organization being set up:
 * the phone goes back to the steps with the first one done.
 */
export default function NewOrganizationScreen() {
  const app = useApp();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  const userId = app.session?.user.userId ?? null;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const flight = useRef(false);
  const shown = useRef(true);
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);

  const trimmed = name.trim();
  const fits = trimmed.length >= ORGANIZATION_NAME.min && trimmed.length <= ORGANIZATION_NAME.max;
  const change = (value: string) => { setName(value); setRefused(false); setFailure(null); };

  const create = async () => {
    if (flight.current || !fits || !catalog || !userId) return;
    flight.current = true;
    setBusy(true);
    setFailure(null);
    const attempt = unanswered?.userId === userId && unanswered.name === trimmed ? unanswered : (unanswered = { userId, name: trimmed, key: Crypto.randomUUID() });
    try {
      const created = await catalog.api.createOrganization(attempt.name, attempt.key);
      if (unanswered === attempt) unanswered = null;
      // Made, whether or not this page is still open: it is the organization being set up.
      chooseSetupOrganization(userId, created.orgId);
      await catalog.refresh().catch(() => undefined);
      // Back past the list of organizations, to the steps.
      if (shown.current) router.dismiss(2);
    } catch (error) {
      const refusal = error instanceof CloudApiError ? error.refusal : "unknown";
      // A no is an answer: the next try is a new request. No answer at all, or one this app
      // could not read, may still have made it, so the same request is sent again.
      if (refusal !== "unreachable" && refusal !== "invalid-response" && unanswered === attempt) unanswered = null;
      if (!shown.current) return;
      if (refusal === "invalid-request") setRefused(true);
      else setFailure(refusal === "unreachable" ? NEW_ORGANIZATION_TEXT.unreachable : refusal === "signed-out" ? NEW_ORGANIZATION_TEXT.signedOut : codeText(error instanceof CloudApiError ? error.code : "unknown"));
    } finally {
      flight.current = false;
      if (shown.current) setBusy(false);
    }
  };

  return <>
    <Stack.Screen options={{ title: "New organization", headerLargeTitle: false, headerBackTitle: "Organization" }} />
    {catalog && userId ? <KeyboardAvoidingView style={[styles.screen, { backgroundColor: palette.page }]} behavior={keyboardAvoidingBehavior()} keyboardVerticalOffset={insets.top + 44}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.page}>
        <TextField testID="organization-name" label={NEW_ORGANIZATION_TEXT.label} placeholder={NEW_ORGANIZATION_TEXT.label} value={name} onChangeText={change}
          autoFocus autoCapitalize="words" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => void create()} disabled={busy}
          helper={NEW_ORGANIZATION_TEXT.helper} error={refused || (trimmed !== "" && !fits) ? NEW_ORGANIZATION_TEXT.length : undefined} />
        {failure ? <View style={styles.notice}><Notice testID="creation-failed" tone="danger" text={failure} /></View> : null}
      </ScrollView>
      <View style={[styles.foot, { backgroundColor: palette.page, borderTopColor: palette.border, paddingBottom: keyboard ? 10 : Math.max(insets.bottom, 10) }]}>
        <Button label={busy ? NEW_ORGANIZATION_TEXT.creating : NEW_ORGANIZATION_TEXT.create} disabled={!fits || busy} accessibilityState={{ disabled: !fits || busy, busy }}
          icon={busy ? (color) => <Spinner size={16} color={color} /> : undefined} onPress={() => void create()} />
      </View>
    </KeyboardAvoidingView> : <EmptyState title="Sign in to create an organization" detail="Organizations belong to your TerminalX account." />}
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  notice: { marginTop: 14 },
  foot: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
