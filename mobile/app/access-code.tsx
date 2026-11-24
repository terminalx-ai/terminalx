import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CircleCheck, UserRound, WifiOff } from "lucide-react-native";
import { ACCEPTED_PAUSE_MS, ACCESS_CODE_TEXT, refusalText, type AccessCodeAnswer, type AccessCodeRefusal, type AccessCodeRequest } from "@mobile/auth/access-code";
import { useApp } from "@mobile/state/AppProvider";
import { clockText, useRemaining } from "@mobile/ui/countdown";
import { useKeyboardShown } from "@mobile/ui/keyboard";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, EmptyState } from "@mobile/ui/primitives";
import { Spinner } from "@mobile/ui/Spinner";
import { TextField, type TextFieldHandle } from "@mobile/ui/TextField";
import { useTheme } from "@mobile/ui/theme";

/** Where the code stands on the page; offline is the phone's, read from the app, not kept here. */
type Phase =
  | { kind: "entering" }
  | { kind: "checking" }
  /** The server refused this code: said under the field until the field changes. */
  | { kind: "refused"; refusal: AccessCodeRefusal; code: string }
  /** No answer, or one that says nothing about the code. */
  | { kind: "unanswered" }
  /** Too many tries: the next one may go at `until` (the phone's clock; the server gave a number of seconds). */
  | { kind: "waiting"; until: number }
  /** The ticket is spent or expired: only a new sign-in goes on. */
  | { kind: "ended" }
  | { kind: "accepted" };

/**
 * The private beta's access code, after sign-in on the phone (25.08,
 * PRO-551). A person the server holds at sign-in, by email or by Google,
 * lands here instead of being signed in. Nothing of the account is on the
 * phone until a code is accepted; Cancel signs the person out. Accepted, the
 * page shows it for a moment and closes onto the Cloud tab's first run.
 */
export default function AccessCodeScreen() {
  const request = useApp().accessCode;
  // The root layout opens and closes this page as the hold comes and goes. A new sign-in, after this one ended, is a new form.
  return request ? <AccessCodeForm key={request.id} request={request} /> : <Stack.Screen options={{ title: ACCESS_CODE_TEXT.title, headerLeft: () => null }} />;
}

function AccessCodeForm({ request }: { request: AccessCodeRequest }) {
  const app = useApp();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  const field = useRef<TextFieldHandle>(null);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "entering" });
  // Try again while offline: the code goes as soon as there is a network (25.08).
  const [armed, setArmed] = useState(false);
  const flight = useRef(false);
  const shown = useRef(true);
  useEffect(() => { shown.current = true; return () => { shown.current = false; }; }, []);

  const value = code.trim();
  const online = app.online;
  const left = useRemaining(phase.kind === "waiting" ? phase.until : null);
  const waiting = phase.kind === "waiting" && left > 0;
  // An armed Try again is under way as soon as there is a network.
  const checking = phase.kind === "checking" || (armed && online);
  const ended = phase.kind === "ended";
  const sameRefused = phase.kind === "refused" && phase.code === value;
  const canSend = value !== "" && online && !checking && !ended && !waiting && !sameRefused && phase.kind !== "accepted";

  const settle = (answer: AccessCodeAnswer, sent: string) => {
    flight.current = false;
    if (!shown.current) return;
    setArmed(false);
    switch (answer.status) {
      case "accepted": setPhase({ kind: "accepted" }); return;
      case "invalid": case "expired": case "exhausted": setPhase({ kind: "refused", refusal: answer.status, code: sent }); return;
      case "rate_limited": setPhase({ kind: "waiting", until: Date.now() + answer.retryAfter * 1000 }); return;
      case "ticket_dead": setPhase({ kind: "ended" }); return;
      case "unanswered": setPhase({ kind: "unanswered" }); return;
    }
  };
  const send = () => {
    if (flight.current || !value || checking || ended || waiting || phase.kind === "accepted") return;
    if (!online) { setArmed(true); return; }
    flight.current = true;
    setPhase({ kind: "checking" });
    void app.redeemAccessCode(value).then((answer) => settle(answer, value));
  };

  // Armed while offline: sent once the network is back.
  const redeem = app.redeemAccessCode;
  useEffect(() => {
    if (!armed || !online || flight.current) return;
    flight.current = true;
    void redeem(value).then((answer) => settle(answer, value));
  });

  // Refused: a mistyped character is the likely cause, so the cursor goes back to the code once the field is unlocked.
  const refused = phase.kind === "refused" ? phase : null;
  useEffect(() => { if (refused) field.current?.focus(); }, [refused]);

  // Accepted: shown for a moment, then the page closes onto the Cloud tab (25.01's first run).
  const finish = app.finishAccessCode;
  useEffect(() => {
    if (phase.kind !== "accepted") return;
    const timer = setTimeout(finish, ACCEPTED_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [finish, phase.kind]);

  const change = (next: string) => {
    setCode(next);
    // The first change takes a refusal away and turns Continue back on; a lost answer is a new try.
    if (phase.kind === "refused" || phase.kind === "unanswered") setPhase({ kind: "entering" });
  };

  const header = <Stack.Screen options={{
    title: ACCESS_CODE_TEXT.title,
    headerLargeTitle: false,
    headerBackVisible: false,
    // Off while checking: the code may already be spent. Gone once accepted.
    headerLeft: phase.kind === "accepted" ? () => null : () => <Pressable accessibilityRole="button" accessibilityLabel={ACCESS_CODE_TEXT.cancel} accessibilityState={{ disabled: checking }} disabled={checking} onPress={app.cancelAccessCode} hitSlop={10}>
      <Text style={[styles.cancel, { color: checking ? palette.faint : palette.ink }]}>{ACCESS_CODE_TEXT.cancel}</Text>
    </Pressable>,
  }} />;

  if (phase.kind === "accepted") return <View testID="access-code-accepted" style={[styles.screen, styles.accepted, { backgroundColor: palette.page }]}>
    {header}
    <EmptyState title={ACCESS_CODE_TEXT.accepted} detail={ACCESS_CODE_TEXT.signedInAs(request.email)} icon={() => <CircleCheck size={28} color={palette.success} />} />
  </View>;

  // Nothing is said under the field when the code could not be checked: a notice above the form says what happened.
  const notice = ended
    ? <Notice testID="access-code-ended" tone="danger" text={ACCESS_CODE_TEXT.ticketDead} action={{ label: ACCESS_CODE_TEXT.signInAgain, disabled: app.signingIn, onPress: () => void app.signIn() }} />
    : !online
      ? <Notice testID="access-code-offline" tone="warning" text={ACCESS_CODE_TEXT.offline} icon={(color) => <WifiOff size={16} color={color} />} action={{ label: ACCESS_CODE_TEXT.tryAgain, disabled: armed || value === "" || waiting || sameRefused, onPress: () => setArmed(true) }} />
      : phase.kind === "waiting"
        ? <Notice testID="access-code-waiting" tone="warning" text={ACCESS_CODE_TEXT.rateLimited} action={{ label: waiting ? ACCESS_CODE_TEXT.tryAgainIn(clockText(left)) : ACCESS_CODE_TEXT.tryAgain, disabled: waiting || value === "", onPress: send }} />
        : phase.kind === "unanswered"
          ? <Notice testID="access-code-unanswered" tone="danger" text={ACCESS_CODE_TEXT.unanswered} action={{ label: ACCESS_CODE_TEXT.tryAgain, onPress: send }} />
          : null;

  return <KeyboardAvoidingView style={[styles.screen, { backgroundColor: palette.page }]} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + 44}>
    {header}
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.page}>
      <Text style={[styles.intro, { color: palette.muted }]}>{ACCESS_CODE_TEXT.intro}</Text>
      {notice}
      <Card style={styles.account} testID="access-code-account">
        <View style={[styles.avatar, { backgroundColor: palette.raised, borderColor: palette.border }]}><UserRound size={16} color={palette.muted} /></View>
        <View style={styles.accountText}>
          <Text selectable style={[styles.email, { color: palette.ink }]}>{request.email}</Text>
          <Text style={[styles.small, { color: palette.muted }]}>{ACCESS_CODE_TEXT.forAccount}</Text>
        </View>
      </Card>
      <TextField ref={field} testID="access-code-field" label={ACCESS_CODE_TEXT.label} placeholder={ACCESS_CODE_TEXT.placeholder} value={code} onChangeText={change}
        paste mono={code !== ""} autoCapitalize="characters" autoCorrect={false} spellCheck={false} autoComplete="off" returnKeyType="go"
        onSubmitEditing={send} disabled={checking || ended}
        helper={ACCESS_CODE_TEXT.helper} error={phase.kind === "refused" ? refusalText(phase.refusal) : null} />
      <Text testID="access-code-no-code" style={[styles.small, styles.noCode, { color: palette.muted }]}>{ACCESS_CODE_TEXT.noCode}</Text>
    </ScrollView>
    <View style={[styles.foot, { backgroundColor: palette.page, borderTopColor: palette.border, paddingBottom: keyboard ? 10 : Math.max(insets.bottom, 10) }]}>
      <Button testID="access-code-continue" label={checking ? ACCESS_CODE_TEXT.checking : ACCESS_CODE_TEXT.continue} disabled={!canSend} accessibilityState={{ disabled: !canSend, busy: checking }}
        icon={checking ? (color) => <Spinner size={16} color={color} /> : undefined} onPress={send} />
    </View>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  page: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 14 },
  accepted: { justifyContent: "center" },
  cancel: { fontSize: 17 },
  intro: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  account: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  avatar: { width: 28, height: 28, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", marginTop: 1 },
  accountText: { flex: 1, minWidth: 0, gap: 2 },
  email: { fontSize: 16, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  noCode: { marginHorizontal: 4, marginTop: -4 },
  foot: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
});
