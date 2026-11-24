import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, AppState, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { ArrowUpRight, CircleCheck, WifiOff } from "lucide-react-native";
import type { CredentialConsent } from "@mobile/cloud/api";
import type { CodexLoginFlow, CodexLoginState } from "@mobile/cloud/codex-login";
import { CODEX_WORDS, connectedText, deviceFailedText, deviceStartText, offlineText } from "@mobile/cloud/logins";
import { Notice } from "@mobile/ui/Notice";
import { OneTimeCode } from "@mobile/ui/OneTimeCode";
import { Button } from "@mobile/ui/primitives";
import { Spinner } from "@mobile/ui/Spinner";
import { useTheme } from "@mobile/ui/theme";
import { LoginPage } from "./LoginPage";

/** Whether the page may be left by its back button: not while a code is being fetched or waited on. */
export const codexSignInLeavable = (state: CodexLoginState): boolean => state.phase !== "starting" && state.phase !== "waiting";

/**
 * "Sign in with ChatGPT" (25.04): the one-time code, the way to OpenAI's
 * page, and the wait for the answer. The page shows whatever the sign-in
 * (`CodexLoginFlow`) is at; while the app is in the background nothing is
 * asked, and coming back asks at once.
 */
export function CodexSignIn({ flow, organization, consent, onDone, onUseKey, onBackToList }: {
  flow: CodexLoginFlow;
  organization: string;
  /** The authorization given on the page before, for a new code. */
  consent: CredentialConsent;
  onDone(): void;
  onUseKey(): void;
  onBackToList(): void;
}) {
  const { palette } = useTheme();
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);
  const [pageProblem, setPageProblem] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") flow.wake();
      else if (next === "background") flow.pause();
    });
    return () => subscription.remove();
  }, [flow]);

  const again = () => { setPageProblem(false); void flow.start(consent); };

  if (state.phase === "idle" || state.phase === "looking") return null;

  if (state.phase === "starting") return <LoginPage testID="codex-sign-in" footer={<Button label="Cancel" kind="secondary" onPress={() => flow.abandon()} />}>
    <View accessible accessibilityRole="progressbar" accessibilityLabel={CODEX_WORDS.starting} style={styles.center}>
      <Spinner size={22} color={palette.accent} />
      <Text style={[styles.title, { color: palette.ink }]}>{CODEX_WORDS.starting}</Text>
    </View>
  </LoginPage>;

  if (state.phase === "done") {
    const words = connectedText(state.credential, organization);
    return <LoginPage testID="codex-sign-in" footer={<Button label="Done" onPress={onDone} />}>
      <View style={styles.center}>
        <CircleCheck size={40} color={palette.success} />
        <Text style={[styles.title, { color: palette.ink }]}>{words.title}</Text>
        <Text style={[styles.detail, { color: palette.muted }]}>{words.detail}</Text>
      </View>
    </LoginPage>;
  }

  if (state.phase === "unavailable") return <LoginPage testID="codex-sign-in" footer={<>
    <Button label="Try again" onPress={again} />
    <Button label="Use an API key" kind="secondary" onPress={onUseKey} />
  </>}>
    <Notice tone="danger" text={deviceStartText(state.refusal)} testID="codex-sign-in-notice" />
  </LoginPage>;

  if (state.phase === "expired" || state.phase === "failed" || state.phase === "canceled") return <LoginPage testID="codex-sign-in" footer={<>
    <Button label="Get a new code" onPress={again} />
    {state.phase === "canceled" ? <Button label="Back to agent logins" kind="secondary" onPress={onBackToList} /> : null}
  </>}>
    <OneTimeCode code={state.code} spent />
    {state.phase === "expired" ? <Notice tone="warning" text={CODEX_WORDS.expired} testID="codex-sign-in-notice" />
      : state.phase === "failed" ? <Notice tone="danger" text={deviceFailedText(state.refusal)} testID="codex-sign-in-notice" />
        : <Notice tone="info" text={CODEX_WORDS.canceled} testID="codex-sign-in-notice" />}
  </LoginPage>;

  const { login, opened, offline, canceling, cancelFailed } = state;
  const openPage = () => {
    setPageProblem(false);
    flow.markOpened();
    // OpenAI's page in the browser sheet the app's own sign-in uses; the wait goes on behind it.
    WebBrowser.openBrowserAsync(login.verificationUri).catch(() => setPageProblem(true));
  };
  const askCancel = () => Alert.alert("Cancel this sign-in?", "The code stops working. Nothing is saved.", [
    { text: "Cancel sign-in", style: "destructive", onPress: () => { void flow.cancel(); } },
    { text: "Keep waiting", style: "cancel" },
  ]);
  return <LoginPage testID="codex-sign-in" footer={<>
    {offline ? null : <Button label={opened ? "Open sign-in page again" : "Open sign-in page"} kind={opened ? "secondary" : "primary"} disabled={canceling} icon={(color) => <ArrowUpRight size={16} color={color} />} onPress={openPage} />}
    <Button label="Cancel sign-in" kind="secondary" disabled={offline || canceling} accessibilityState={{ disabled: offline || canceling, busy: canceling }} onPress={askCancel} />
  </>}>
    <OneTimeCode code={login.userCode} expiresAt={login.expiresAt} onExpired={() => flow.expire()} />
    {offline ? <Notice tone="warning" text={offlineText(login.expiresAt)} icon={(color) => <WifiOff size={16} color={color} />} testID="codex-sign-in-notice" />
      : opened ? <View accessible accessibilityLabel={CODEX_WORDS.waiting} style={styles.waiting}>
        <Spinner size={16} color={palette.muted} />
        <Text style={[styles.waitingText, { color: palette.ink }]}>{CODEX_WORDS.waiting}</Text>
      </View>
        : <Text style={[styles.how, { color: palette.muted }]}>{CODEX_WORDS.shown}</Text>}
    {cancelFailed && !offline ? <Notice tone="danger" text={CODEX_WORDS.notCanceled} testID="codex-sign-in-problem" /> : null}
    {pageProblem ? <Notice tone="danger" text={CODEX_WORDS.pageNotOpened} testID="codex-sign-in-problem" /> : null}
  </LoginPage>;
}

const styles = StyleSheet.create({
  center: { alignItems: "center", gap: 8, paddingTop: 70, paddingHorizontal: 16 },
  title: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  detail: { fontSize: 14, lineHeight: 21, textAlign: "center" },
  how: { fontSize: 14, lineHeight: 21, marginHorizontal: 4 },
  waiting: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginHorizontal: 4 },
  waitingText: { flex: 1, fontSize: 14, lineHeight: 21 },
});
