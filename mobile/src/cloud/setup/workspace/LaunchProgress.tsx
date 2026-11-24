import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WifiOff } from "lucide-react-native";
import { CloudApiError, type CloudLifecycle, type CloudRole } from "../../api";
import type { CloudCatalog } from "../../catalog";
import { resumeFailure } from "../../resume";
import { refusalText, rolePhrase, stateLabel } from "../../words";
import { Notice } from "../../../ui/Notice";
import { OperationStages } from "../../../ui/OperationStages";
import { Button, EmptyState } from "../../../ui/primitives";
import { HeaderLine, ScreenHeader } from "../../../ui/SessionChrome";
import { Spinner } from "../../../ui/Spinner";
import { useTheme } from "../../../ui/theme";
import { deleteHref, mayManage } from "./actions";
import type { ProviderWords } from "./hooks";
import { launchView } from "./launch";
import { LAUNCH, STOP } from "./sentences";

/** How long "Opening it in a moment…" shows before the workspace opens by itself. */
export const OPEN_AFTER_MS = 4_000;

/**
 * A launch on the workspace's page (25.05, its last two rows): the
 * operation's stages as the server answers them, Cancel while it can still be
 * canceled, and when it does not finish, the cause, what it left at the
 * provider and what can be done next. The launch is the server's: leaving the
 * page, or losing the network, changes nothing about it.
 */
export function LaunchProgress({ catalog, title, lifecycle, role, provider, offline, refresh, onOpen, onBack, onBackToCloud, push }: {
  catalog: CloudCatalog;
  title: string;
  /** The operation as last read; null while the first read is under way. */
  lifecycle: CloudLifecycle | null;
  role: CloudRole | null;
  provider: ProviderWords | null;
  /** The last read could not reach the service. */
  offline: boolean;
  refresh(): Promise<void>;
  /** Open workspace: the workspace page as it is today. */
  onOpen(): void;
  onBack(): void;
  onBackToCloud(): void;
  push(href: string): void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [canceling, setCanceling] = useState(false);
  const inFlight = useRef(false);
  const providerName = provider?.label ?? "The provider";
  const view = lifecycle ? launchView(lifecycle.operation, { name: title }, provider?.label ?? STOP_PROVIDER) : null;
  const finished = view?.phase === "finished";

  // Running: it opens by itself in a moment, as the page says.
  useEffect(() => {
    if (!finished) return;
    const timer = setTimeout(onOpen, OPEN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [finished, onOpen]);

  const line = !view ? null
    : offline ? "Offline"
    : view.phase === "finished" ? `Live${role ? ` · ${rolePhrase(role)}` : ""}`
    : view.phase === "canceled" ? stateLabel(lifecycle!.workspace.state)
    : [view.phase === "running" || view.phase === "canceling" ? "Starting" : stateLabel(lifecycle!.workspace.state), rolePhrase(role)].filter(Boolean).join(" · ");

  const cancel = () => Alert.alert(LAUNCH.cancelTitle, LAUNCH.cancelMessage(providerName), [
    { text: LAUNCH.keep, style: "cancel" },
    { text: LAUNCH.cancel, style: "destructive", onPress: () => {
      if (!lifecycle || inFlight.current) return;
      inFlight.current = true;
      setCanceling(true);
      void catalog.api.cancelOperation(lifecycle.workspace.orgId, lifecycle.operation.id)
        .then(() => refresh(), (error: unknown) => Alert.alert(LAUNCH.cancelTitle, error instanceof CloudApiError ? refusalText(error) : refusalText("unknown")))
        .finally(() => { inFlight.current = false; setCanceling(false); });
    } },
  ]);
  const retry = () => Alert.alert(LAUNCH.retryTitle, LAUNCH.retryMessage, [
    { text: STOP.cancel, style: "cancel" },
    { text: LAUNCH.retrySetup, onPress: () => {
      if (!lifecycle) return;
      void catalog.start(lifecycle.workspace.orgId, lifecycle.workspace.id).catch((error: unknown) => Alert.alert(STOP.startFailedTitle, resumeFailure(error).text));
    } },
  ]);

  const manager = role === "manager" || mayManage(lifecycle?.workspace);
  const workspace = lifecycle?.workspace;
  const del = workspace && manager ? <Button key="delete" label={LAUNCH.delete} kind="danger" onPress={() => push(deleteHref(workspace))} /> : null;
  const back = <Button key="back" label={LAUNCH.backToCloud} kind="secondary" onPress={onBackToCloud} />;
  const cancelBusy = canceling || view?.phase === "canceling";
  const buttons = !view ? null
    : view.phase === "finished" ? [<Button key="open" label={LAUNCH.open} onPress={onOpen} />]
    : view.phase === "running" || view.phase === "canceling" ? [<Button key="cancel" label={LAUNCH.cancel} kind="secondary" disabled={offline || cancelBusy || !view.cancelable || !manager} icon={cancelBusy ? (color) => <Spinner size={16} color={color} /> : undefined} onPress={cancel} />]
    : view.failure === "canceled" ? [<Button key="again" label={LAUNCH.launchAgain} onPress={() => push(`/cloud/launch?orgId=${encodeURIComponent(workspace!.orgId)}`)} />, back]
    : view.failure === "runtime" ? [manager ? <Button key="retry" label={LAUNCH.retrySetup} onPress={retry} /> : null, del ?? back]
    : view.failure === "key" ? [<Button key="key" label={LAUNCH.fixKey} onPress={() => push(`/cloud/compute/${encodeURIComponent(workspace!.provider)}?orgId=${encodeURIComponent(workspace!.orgId)}`)} />, del ?? back]
    : [del, back];

  return <View style={[styles.page, { backgroundColor: palette.page }]}>
    <Stack.Screen options={{ title, headerShown: false }} />
    <ScreenHeader title={title} onBack={onBack} subtitle={line ? <HeaderLine testID="workspace-state-line" text={line} /> : undefined} />
    {!view ? <EmptyState title={LAUNCH.reading} detail={LAUNCH.readingDetail} busy />
      : <>
        <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
          {offline ? <Notice tone="warning" text={LAUNCH.offline} icon={(color) => <WifiOff size={16} color={color} />} testID="launch-offline" /> : null}
          <Text accessibilityRole="header" style={[styles.heading, { color: palette.ink }]}>{view.title}</Text>
          <OperationStages testID="launch-stages" stages={view.stages} current={view.current} status={view.status} detail={view.detail} />
          {view.note && !offline ? view.note.tone === "warning"
            ? <Notice tone="warning" text={view.note.text} testID="launch-note" />
            : <Text testID="launch-note" style={[styles.note, { color: palette.muted }]}>{view.note.text}</Text> : null}
        </ScrollView>
        <View style={[styles.footer, { borderTopColor: palette.border, paddingBottom: insets.bottom + 8 }]}>{buttons}</View>
      </>}
  </View>;
}

/** The provider's name in "Check …’s dashboard" when the server named none. */
const STOP_PROVIDER = "the provider";

const styles = StyleSheet.create({
  page: { flex: 1 },
  flex: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, gap: 10 },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "700", marginTop: 4 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 10, gap: 8 },
});
