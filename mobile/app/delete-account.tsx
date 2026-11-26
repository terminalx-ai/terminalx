import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { KeyboardAvoidingView, Linking, ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import { Stack, useRouter } from "expo-router";
import { CalendarClock, CircleCheck, ExternalLink, TriangleAlert, WifiOff, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { accountDeletionText as T, blockerRows, deleteAfterFrom, deletionDate, emailConfirmed, goneRows } from "@mobile/account/deletion";
import { useAccountDeletion, type DeletionNotice } from "@mobile/account/useAccountDeletion";
import { useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { providerNamesFor } from "@mobile/cloud/provider-names";
import { useApp } from "@mobile/state/AppProvider";
import { keyboardAvoidingBehavior, useKeyboardShown } from "@mobile/ui/keyboard";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card, SectionTitle } from "@mobile/ui/primitives";
import { Spinner } from "@mobile/ui/Spinner";
import { useLargeText } from "@mobile/ui/text-size";
import { TextField } from "@mobile/ui/TextField";
import { useTheme } from "@mobile/ui/theme";

const NO_NAMES = new Map<string, ReadonlyMap<string, string>>();
const none = () => NO_NAMES;
const never = () => () => undefined;

/**
 * Delete account (PRO-584, board 26.01), opened from its row on Account: the
 * 14 days' grace first, what stands in the way (each opening where it is
 * fixed), what is deleted and what is kept, signing in again when the
 * sign-in is not recent, and the account's address typed to confirm. The
 * button stays at the foot in every state, so it never moves.
 */
export default function DeleteAccountScreen() {
  const app = useApp();
  const router = useRouter();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const large = useLargeText();
  const keyboard = useKeyboardShown();
  const catalog = useCloudCatalog();
  const scroll = useRef<ScrollViewInstance>(null);
  // Kept from when the page opened: after the deletion is scheduled the phone is signed out.
  const [email] = useState(() => app.session?.user.email ?? null);
  const [openedAt] = useState(() => Date.now());
  const providers = useMemo(() => (catalog ? providerNamesFor(catalog) : null), [catalog]);
  const names = useSyncExternalStore(providers?.subscribe ?? never, providers?.getSnapshot ?? none, providers?.getSnapshot ?? none);
  const running = useRef<ReadonlyMap<string, string>>(new Map());
  const deletion = useAccountDeletion({
    api: catalog?.api ?? null,
    email,
    online: app.online,
    reauthenticate: app.reauthenticate,
    forgetDeletedAccount: app.forgetDeletedAccount,
    providerName: (providerId, workspaceId) => {
      const orgId = workspaceId ? running.current.get(workspaceId) : undefined;
      // Never the provider's id: in this sentence it would read as a code.
      return (orgId && names.get(orgId)?.get(providerId)) || T.someProvider;
    },
  });
  const { phase, read, sending, notice } = deletion;

  // The running cloud workspaces' organizations: their provider names, for a refusal to stop one.
  useEffect(() => {
    if (!read || !providers) return;
    running.current = new Map(read.deleted.runningWorkspaces.map((workspace) => [workspace.id, workspace.organizationId]));
    for (const orgId of new Set(running.current.values())) providers.need(orgId);
  }, [providers, read]);

  const [typed, setTyped] = useState("");
  const [left, setLeft] = useState(false);
  // A notice says what happened: "something changed" goes with the list at the top, the rest with the confirmation.
  useEffect(() => {
    if (!notice) return;
    if (notice.kind === "blocked") scroll.current?.scrollTo({ y: 0, animated: true });
    else scroll.current?.scrollToEnd({ animated: true });
  }, [notice]);

  if (phase.kind === "scheduled") return <Scheduled deleteAfter={phase.deleteAfter} graceDays={phase.graceDays} stopped={phase.stopped} large={large} onDone={() => router.dismissTo("/settings")} />;
  if (phase.kind === "finishing") return <Finishing onSignOut={() => void app.signOut().then(() => router.dismissTo("/settings"))} />;

  const header = <Stack.Screen options={{ title: T.title }} />;
  if (!email || !app.session) return <>{header}<View style={[styles.center, { backgroundColor: palette.page }]}><Text style={[styles.body, { color: palette.muted }]}>Not signed in.</Text></View></>;
  if (!read) {
    return <>{header}<View style={[styles.screen, styles.loading, { backgroundColor: palette.page }]}>
      {phase.kind === "unreadable"
        ? <Notice testID="delete-account-unreadable" tone="danger" text={T.unreadable} action={{ label: T.tryAgain, onPress: deletion.reload }} />
        : <Spinner size={24} color={palette.muted} />}
    </View></>;
  }

  const blocked = read.blockers.length > 0;
  const rows = blockerRows(read.blockers);
  const stale = !read.recentSignIn;
  const matched = emailConfirmed(typed, email);
  const working = sending !== null;
  const on = !blocked && !stale && matched && !working && !deletion.signingIn && notice?.kind !== "unknown";
  const mismatch = deletion.mismatch || (left && typed.trim() !== "" && !matched);
  // "Before" a date that is the 14 days from now, the earliest it could be.
  const on14 = deletionDate(deleteAfterFrom(openedAt, read.graceDays));
  const noteInPage = large && !blocked;

  return <>
    {header}
    <KeyboardAvoidingView style={[styles.screen, { backgroundColor: palette.page }]} behavior={keyboardAvoidingBehavior()} keyboardVerticalOffset={insets.top + 44}>
      <ScrollView ref={scroll} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={styles.screen} contentContainerStyle={styles.page}>
        {notice?.kind === "blocked" ? <NoticeFor notice={notice} email={email} onCheck={deletion.check} /> : null}
        <Text style={[styles.lede, { color: palette.muted }]}>{T.lede(read.graceDays)}</Text>
        {blocked ? <>
          <SectionTitle>{T.blockedHead}</SectionTitle>
          <Card testID="delete-account-blockers">{rows.map((row, index) => <View key={row.key} style={[styles.row, styles.blockRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}>
            <View style={styles.mark}><TriangleAlert size={18} color={palette.warning} /></View>
            <View style={styles.flex}>
              <Text style={[styles.blockTitle, { color: palette.ink }]}>{row.title}</Text>
              {row.detail ? <Text style={[styles.small, { color: palette.muted }]}>{row.detail}</Text> : null}
              {row.consoleUrl ? <View style={styles.action}><Button label={T.openConsole} kind="secondary" size="small" icon={(color) => <ExternalLink size={14} color={color} />} onPress={() => void Linking.openURL(row.consoleUrl!)} /></View> : null}
            </View>
          </View>)}</Card>
        </> : null}
        <SectionTitle>{T.goneHead}</SectionTitle>
        <Card testID="delete-account-gone">{goneRows(read, email).map(([title, detail], index) => <View key={title} style={[styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}>
          <View style={styles.mark}><X size={18} color={palette.muted} /></View>
          <View style={styles.flex}>
            <Text style={[styles.rowTitle, { color: palette.ink }]}>{title}</Text>
            {detail ? <Text style={[styles.small, { color: palette.muted }]}>{detail}</Text> : null}
          </View>
        </View>)}</Card>
        <SectionTitle>{T.keptHead}</SectionTitle>
        <Card style={styles.pad}><Text style={[styles.kept, { color: palette.muted }]}>{T.kept(read.retentionDays)}</Text></Card>
        {blocked ? null : <>
          {notice && notice.kind !== "blocked" ? <NoticeFor notice={notice} email={email} onCheck={deletion.check} /> : null}
          {stale ? <>
            <SectionTitle>{T.reauthHead}</SectionTitle>
            <Card style={[styles.pad, styles.reauth]}>
              <Text style={[styles.body, { color: palette.ink }]}>{T.reauthLede}</Text>
              <Button testID="delete-account-sign-in" label={deletion.signingIn ? T.reauthBusy : T.reauthButton} kind="secondary" disabled={deletion.signingIn || working}
                accessibilityState={{ disabled: deletion.signingIn || working, busy: deletion.signingIn }}
                icon={deletion.signingIn ? (color) => <Spinner size={16} color={color} /> : undefined} onPress={deletion.signInAgain} />
            </Card>
          </> : <View style={styles.signedIn}><CircleCheck size={16} color={palette.success} /><Text style={[styles.signedInText, { color: palette.muted }]}>{T.reauthDone}</Text></View>}
          <SectionTitle>{T.confirmHead}</SectionTitle>
          {noteInPage ? <Text style={[styles.body, { color: palette.muted }]}>{T.signOutNote(on14)}</Text> : null}
          <TextField testID="delete-account-email" label={T.typeLabel} value={typed} placeholder={email}
            onChangeText={(value) => { setTyped(value); setLeft(false); }} onBlur={() => setLeft(true)}
            onSubmitEditing={() => setLeft(true)} disabled={stale || working || deletion.signingIn}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} returnKeyType="done"
            helper={T.typeHint} error={mismatch ? T.mismatch : null} />
        </>}
      </ScrollView>
      <View style={[styles.foot, { backgroundColor: palette.page, borderTopColor: palette.border, paddingBottom: keyboard ? 10 : Math.max(insets.bottom, 10) }]}>
        <Button testID="delete-account-confirm" kind="danger" label={working ? (sending === "stopping" ? T.stopping : T.busy) : T.confirmButton}
          disabled={!on} accessibilityState={{ disabled: !on, busy: working }}
          icon={working ? (color) => <Spinner size={16} color={color} /> : undefined}
          onPress={() => { setLeft(true); if (on) deletion.confirm(); }} />
        {blocked ? <Text style={[styles.small, styles.footNote, { color: palette.muted }]}>{T.blockedConfirm}</Text>
          : keyboard || noteInPage ? null : <Text style={[styles.small, styles.footNote, { color: palette.muted }]}>{T.signOutNote(on14)}</Text>}
      </View>
    </KeyboardAvoidingView>
  </>;
}

function NoticeFor({ notice, email, onCheck }: { notice: DeletionNotice; email: string; onCheck(): void }) {
  switch (notice.kind) {
    case "refused": return <Notice testID="delete-account-refused" tone={notice.tone} text={notice.text} />;
    case "stale": return <Notice testID="delete-account-stale" tone="warning" text={T.failStale} />;
    case "blocked": return <Notice testID="delete-account-changed" tone="warning" text={T.failBlocked} />;
    case "unknown": return <Notice testID="delete-account-unknown" tone="warning" text={T.failUnknown} action={{ label: T.check, onPress: onCheck }} />;
    case "offline": return <Notice testID="delete-account-offline" tone="danger" text={T.offline} icon={(color) => <WifiOff size={16} color={color} />} />;
    case "other-account": return <Notice testID="delete-account-other-account" tone="warning" text={T.otherAccount(email)} />;
  }
}

/** Board 26.01 screen 6: what a signed-out person sees after confirming. Nothing here cancels it but signing in. */
function Scheduled({ deleteAfter, graceDays, stopped, large, onDone }: { deleteAfter: number | null; graceDays: number; stopped: number; large: boolean; onDone(): void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  // The day the server gave; when every device was signed out before it was read, the grace it gave instead.
  const on = useMemo(() => (deleteAfter === null ? null : deletionDate(deleteAfter)), [deleteAfter]);
  const head = on === null ? T.doneHeadIn(graceDays) : T.doneHead(on);
  const stoppedText = on === null ? T.doneStoppedIn(stopped) : T.doneStopped(stopped, on);
  const keep = on === null ? T.doneKeepIn(graceDays) : T.doneKeep(on);
  const after = on === null ? T.doneAfterIn : T.doneAfter(on);
  return <>
    <Stack.Screen options={{ title: "", headerBackVisible: false, gestureEnabled: false }} />
    <View style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScrollView contentContainerStyle={styles.outcome}>
        <CalendarClock size={40} color={palette.muted} />
        <Text accessibilityRole="header" style={[styles.outcomeTitle, { color: palette.ink }]}>{head}</Text>
        <Text style={[styles.body, styles.centered, { color: palette.muted }]}>{stopped > 0 ? `${T.doneBody} ${stoppedText}` : T.doneBody}</Text>
        <Text style={[styles.body, styles.centered, { color: palette.ink }]}>{keep}</Text>
        {/* At the accessibility sizes the page keeps to what must be said. */}
        {large ? null : <Text style={[styles.small, styles.centered, { color: palette.muted }]}>{after}</Text>}
      </ScrollView>
      <View style={[styles.foot, { backgroundColor: palette.page, borderTopColor: palette.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
        <Button testID="delete-account-done" label={T.doneButton} onPress={onDone} />
      </View>
    </View>
  </>;
}

/** Board 26.01 screen 20: the 14 days have passed and the final deletion runs; signing in no longer cancels it. */
function Finishing({ onSignOut }: { onSignOut(): void }) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  return <>
    <Stack.Screen options={{ title: "", headerBackVisible: false, gestureEnabled: false }} />
    <View style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScrollView contentContainerStyle={styles.outcome}>
        <Spinner size={30} color={palette.muted} />
        <Text accessibilityRole="header" style={[styles.outcomeTitle, { color: palette.ink }]}>{T.finishing}</Text>
        <Text style={[styles.body, styles.centered, { color: palette.muted }]}>{T.finishingBody}</Text>
      </ScrollView>
      <View style={[styles.foot, { backgroundColor: palette.page, borderTopColor: palette.border, paddingBottom: Math.max(insets.bottom, 10) }]}>
        <Button label={T.signOut} kind="secondary" onPress={onSignOut} />
      </View>
    </View>
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  loading: { padding: 16, alignItems: "stretch", justifyContent: "center" },
  page: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 12 },
  lede: { fontSize: 15, lineHeight: 21, marginTop: 2, marginHorizontal: 4 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  blockRow: { paddingVertical: 12 },
  mark: { width: 22, alignItems: "center", marginTop: 1 },
  flex: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 15, lineHeight: 20 },
  blockTitle: { fontSize: 16, lineHeight: 21, fontWeight: "600" },
  action: { flexDirection: "row", marginTop: 10 },
  small: { fontSize: 13, lineHeight: 18 },
  pad: { padding: 14 },
  kept: { fontSize: 14, lineHeight: 21 },
  reauth: { gap: 12 },
  body: { fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  signedIn: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4, marginHorizontal: 4 },
  signedInText: { fontSize: 14 },
  foot: { paddingHorizontal: 16, paddingTop: 10, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  footNote: { textAlign: "center", marginHorizontal: 6 },
  outcome: { alignItems: "center", gap: 10, paddingHorizontal: 24, paddingTop: 40, paddingBottom: 24 },
  outcomeTitle: { fontSize: 22, lineHeight: 29, fontWeight: "600", textAlign: "center" },
  centered: { textAlign: "center" },
});
