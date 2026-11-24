import { useCallback, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ArrowUpRight, CircleCheck, WifiOff } from "lucide-react-native";
import { refusalText } from "../../words";
import { useCloudApi } from "../read";
import { Notice } from "../../../ui/Notice";
import { OneTimeCode } from "../../../ui/OneTimeCode";
import { Button, EmptyState } from "../../../ui/primitives";
import { Spinner } from "../../../ui/Spinner";
import { useTheme } from "../../../ui/theme";
import { clockAt } from "./agents";
import { useDeviceLogin } from "./device";
import { Page } from "./parts";
import { CONSENT } from "./ProviderScreen";
import { useOrganization } from "./ListScreen";
import { CANCEL_TEXT, CANCEL_TITLE, CODE_INSTRUCTIONS, GETTING_CODE, WAITING, connectedAs, connectedDetail, failure, offline } from "./words";

const TITLE = "Sign in with ChatGPT";

/**
 * Codex's "Sign in with ChatGPT" (25.04): the one-time code, large, with the
 * way to OpenAI's page in the browser sheet the app's own sign-in uses.
 * While the page is in view and the app in front it asks the server every few
 * seconds whether the person has finished; leaving and coming back carries on
 * with the same code. The admin authorized the login on the form before the
 * code was asked for, and that authorization goes with every question.
 */
export function CodexSignInScreen() {
  const params = useLocalSearchParams<{ orgId?: string; authorized?: string }>();
  const orgId = typeof params.orgId === "string" && params.orgId ? params.orgId : null;
  const authorized = params.authorized === "1";
  const api = useCloudApi();
  const router = useRouter();
  const { palette } = useTheme();
  const organization = useOrganization(orgId);
  const [shown, setShown] = useState(false);
  useFocusEffect(useCallback(() => { setShown(true); return () => setShown(false); }, []));
  const login = useDeviceLogin(api, orgId, authorized ? CONSENT : null, shown);
  const { state } = login;

  // Without the admin's authorization nothing is asked: the form asks for it first.
  if (orgId && !authorized) return <Redirect href={`/cloud/logins/codex?orgId=${encodeURIComponent(orgId)}&how=chatgpt`} />;
  // While a code can still be used the page is left only by Cancel, which tells the server.
  const live = state.phase === "code" || state.phase === "requesting";
  const backable = state.phase === "start-failed" || state.phase === "connected" || (state.phase === "ended" && state.outcome === "canceled");
  const header = <Stack.Screen options={{ title: TITLE, headerLargeTitle: false, headerBackButtonDisplayMode: "minimal", headerBackVisible: backable, gestureEnabled: !live }} />;
  if (!api) return <Page>{header}<EmptyState title={TITLE} detail={refusalText("signed-out")} /></Page>;
  if (!orgId) return <Page>{header}<EmptyState title={TITLE} detail={refusalText("not-found")} /></Page>;

  const back = () => router.back();
  const useKey = () => router.replace(`/cloud/logins/codex?orgId=${encodeURIComponent(orgId)}&how=api-key`);
  const confirmCancel = () => Alert.alert(CANCEL_TITLE, CANCEL_TEXT, [
    { text: "Keep waiting", style: "cancel" },
    { text: "Cancel sign-in", onPress: () => void login.cancel().then((error) => { if (error) Alert.alert("Not canceled", failure(error)); }) },
  ]);

  if (state.phase === "requesting") {
    return <Page testID="sign-in-requesting" footer={<Button label="Cancel" kind="secondary" onPress={() => { login.abandon(); back(); }} />}>
      {header}
      <View style={styles.centre}>
        <Spinner size={22} color={palette.accent} />
        <Text style={[styles.lead, { color: palette.ink }]}>{GETTING_CODE}</Text>
      </View>
    </Page>;
  }
  if (state.phase === "start-failed") {
    return <Page testID="sign-in-unavailable" footer={<><Button label="Try again" onPress={login.restart} /><Button label="Use an API key" kind="secondary" onPress={useKey} /></>}>
      {header}
      <Notice tone="danger" text={failure(state.error)} />
    </Page>;
  }
  if (state.phase === "connected") {
    return <Page testID="sign-in-connected" footer={<Button label="Done" onPress={back} />}>
      {header}
      <View style={styles.centre}>
        <CircleCheck size={36} color={palette.success} />
        <Text accessibilityRole="header" style={[styles.lead, { color: palette.ink }]}>{connectedAs(state.identity)}</Text>
        <Text style={[styles.detail, { color: palette.muted }]}>{connectedDetail(organization.name ?? "This organization")}</Text>
      </View>
    </Page>;
  }
  if (state.phase === "ended") {
    const tone = state.outcome === "canceled" ? "info" : state.outcome === "expired" ? "warning" : "danger";
    return <Page testID={`sign-in-${state.outcome}`} footer={<><Button label="Get a new code" onPress={login.restart} />{state.outcome === "canceled" ? <Button label="Back to agent logins" kind="secondary" onPress={back} /> : null}</>}>
      {header}
      <OneTimeCode code={state.code} spent />
      <Notice tone={tone} text={state.text} testID="sign-in-ended" />
    </Page>;
  }

  const { attempt } = state;
  const open = () => {
    login.opened();
    void WebBrowser.openBrowserAsync(attempt.login.verificationUri).catch(() => undefined);
  };
  const footer = state.offline
    ? <Button label="Cancel sign-in" kind="secondary" disabled onPress={confirmCancel} />
    : <>
      <Button label={attempt.opened ? "Open sign-in page again" : "Open sign-in page"} kind={attempt.opened ? "secondary" : "primary"} icon={(color) => <ArrowUpRight size={16} color={color} />} onPress={open} />
      <Button label="Cancel sign-in" kind="secondary" onPress={confirmCancel} />
    </>;
  return <Page testID={state.offline ? "sign-in-offline" : attempt.opened ? "sign-in-waiting" : "sign-in-code"} footer={footer}>
    {header}
    <OneTimeCode code={attempt.login.userCode} expiresAt={attempt.expiresAt} onExpired={login.expire} />
    {state.offline
      ? <Notice tone="warning" icon={(color) => <WifiOff size={16} color={color} />} text={offline(clockAt(attempt.expiresAt))} testID="sign-in-offline-notice" />
      : attempt.opened
        ? <View accessibilityLiveRegion="polite" style={styles.waiting}><Spinner size={16} color={palette.info} /><Text style={[styles.waitingText, { color: palette.ink }]}>{WAITING}</Text></View>
        : <Text style={[styles.detail, styles.left, { color: palette.muted }]}>{CODE_INSTRUCTIONS}</Text>}
  </Page>;
}

const styles = StyleSheet.create({
  centre: { alignItems: "center", gap: 12, paddingTop: 72, paddingHorizontal: 16 },
  lead: { fontSize: 17, lineHeight: 24, fontWeight: "600", textAlign: "center" },
  detail: { fontSize: 14, lineHeight: 21, textAlign: "center" },
  left: { textAlign: "left", marginHorizontal: 4 },
  waiting: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginHorizontal: 4 },
  waitingText: { flex: 1, fontSize: 14, lineHeight: 21 },
});
