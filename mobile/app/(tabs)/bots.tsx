import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight, Pause } from "lucide-react-native";
import { ago, entryQuestion, teamStatus, type Bot, type NeedsYouEntry } from "@mobile/data/bots";
import { useApp } from "@mobile/state/AppProvider";
import { useBotsOverview, useNow } from "@mobile/state/bots";
import { botsOffDetail, useHostWords } from "@mobile/state/host-words";
import { connectionUsable, useConnectionState } from "@mobile/state/connection-view";
import { screenMessage } from "@mobile/transport/connection-errors";
import { Asker, BotAvatar, BotQuestionCard, BotSection, NeedsYouHeading, useBotAnswer } from "@mobile/ui/bots";
import { BotQuestionSheet } from "@mobile/ui/BotQuestionSheet";
import { GlassIconButton } from "@mobile/ui/glass";
import { Button, Card, EmptyState, Screen } from "@mobile/ui/primitives";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { withTextSizePage } from "@mobile/ui/text-size";
import { useTheme } from "@mobile/ui/theme";

/**
 * The Bots tab (23.08): what needs you across every bot first, the newest
 * question answerable from the list, then the team. Shown only while the
 * connected Mac offers its bots (`bots`), which it does only with Bots on.
 */
function BotsScreen() {
  const app = useApp();
  const router = useRouter();
  const { palette } = useTheme();
  const host = app.activeHost;
  const overview = useBotsOverview(app.api, host?.id, app.connectionEpoch, app.sessions);
  const connected = connectionUsable(useConnectionState(app));
  const answers = useBotAnswer(app.api, () => void overview.refresh());
  const pull = usePullRefresh(overview.refresh);
  const [open, setOpen] = useState<{ botId: string; number: number } | null>(null);
  const [pausing, setPausing] = useState(false);
  const value = overview.value;
  const bots = useMemo(() => new Map((value?.bots.bots ?? []).map((bot) => [bot.id, bot])), [value]);
  const now = useNow();
  const words = useHostWords();

  if (!host) return <Screen title="Bots"><EmptyState title="Choose a computer" detail="Connect to a paired computer to see its bots." /><Button label="Open Machines" onPress={() => router.navigate("/(tabs)")} /></Screen>;
  if (overview.offered === false) return <Screen title="Bots"><EmptyState title="Bots are off" detail={botsOffDetail(host.platform)} /></Screen>;

  const entries = (value?.needsYou.entries ?? []).filter((entry) => bots.has(entry.botId));
  const team = value?.bots.bots ?? [];
  const counts = new Map((value?.needsYou.counts ?? []).map((count) => [count.botId, count]));
  const lines = new Map((value?.team ?? []).map((line) => [line.botId, line]));
  const everyPaused = team.length > 0 && team.every((bot) => bot.paused);

  const openEntry = (entry: NeedsYouEntry) => {
    if (entry.kind === "item") return setOpen({ botId: entry.botId, number: entry.item.number });
    // An agent's question in one of the bot's sessions is answered on its card there.
    router.push({ pathname: "/session/[sessionId]", params: { sessionId: entry.sessionId, tabId: entry.tabId, hostId: host.id, title: entry.sessionTitle } });
  };
  const pauseAll = () => Alert.alert("Pause every bot?", "Their duties stop waking and they start no new work until you resume them. Each still answers you in its chat.", [
    { text: "Cancel", style: "cancel" },
    { text: "Pause all", style: "destructive", onPress: () => {
      setPausing(true);
      void app.api.pauseAllBots().then(() => overview.refresh())
        .catch((cause: unknown) => Alert.alert("Could not pause the bots", screenMessage(cause, `Couldn’t reach ${words.the}. Try again once it is connected.`)))
        .finally(() => setPausing(false));
    } },
  ]);

  const [newest, ...others] = entries;
  const sheetEntry = open ? entries.find((entry) => entry.kind === "item" && entry.botId === open.botId && entry.item.number === open.number) : undefined;
  const sheetBot = open ? bots.get(open.botId) : undefined;

  return <Screen title="Bots" titleActions={team.length ? <GlassIconButton label={everyPaused ? "Every bot is paused" : "Pause all bots"} disabled={everyPaused || pausing || !connected} icon={<Pause size={18} color={palette.ink} strokeWidth={1.8} />} onPress={pauseAll} /> : undefined}
    refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} />}>
    {overview.error && !value ? <EmptyState title="Bots unavailable" detail={overview.error} /> : null}
    {!value && !overview.error ? <EmptyState busy title="Loading bots" detail={`Reading the team from ${words.your}.`} /> : null}
    {entries.length ? <>
      <NeedsYouHeading count={entries.length} />
      {newest ? <NewestQuestion entry={newest} bot={bots.get(newest.botId)!} now={now} connected={connected} answering={answers.answering} error={newest.kind === "item" ? answers.errors[`${newest.botId}:${newest.item.number}`] : undefined}
        onAnswer={(index) => newest.kind === "item" && void answers.answer(bots.get(newest.botId)!, newest.item, { answer: index })} onOpen={() => openEntry(newest)} /> : null}
      {others.length ? <Card>{others.map((entry, index) => {
        const bot = bots.get(entry.botId)!;
        return <Pressable key={entry.kind === "item" ? `${entry.botId}:${entry.item.number}` : `${entry.sessionId}:${entry.requestId}`} accessibilityRole="button" accessibilityLabel={`${bot.name} asks: ${entryQuestion(entry)}`} onPress={() => openEntry(entry)}
          style={({ pressed }) => [styles.row, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.selected }]}>
          <BotAvatar bot={bot} size={28} />
          <Text numberOfLines={1} style={[styles.rowText, { color: palette.ink }]}>{entryQuestion(entry)}</Text>
          <ChevronRight size={16} color={palette.muted} />
        </Pressable>;
      })}</Card> : null}
    </> : null}
    {value ? <>
      <BotSection>{team.length === 1 ? "Team · 1 bot" : `Team · ${team.length} bots`}</BotSection>
      {team.length ? <Card>{team.map((bot, index) => <TeamRow key={bot.id} bot={bot} first={index === 0} status={teamStatus(bot, lines.get(bot.id), counts.get(bot.id)?.needsYou ?? 0, now)} onPress={() => router.push({ pathname: "/bot/[botId]", params: { botId: bot.id, name: bot.name } })} />)}</Card>
        : <EmptyState title="No bots yet" detail={`Hire one on ${words.your}, from Bots in the sidebar.`} />}
    </> : null}
    {overview.error && value ? <Text style={[styles.error, { color: palette.danger }]}>{overview.error}</Text> : null}
    {open && sheetBot ? <BotQuestionSheet bot={sheetBot} item={sheetEntry?.kind === "item" ? sheetEntry.item : null} connected={connected} busy={answers.answering === `${open.botId}:${open.number}`} error={answers.errors[`${open.botId}:${open.number}`]}
      onAnswer={(reply) => sheetEntry?.kind === "item" ? answers.answer(sheetBot, sheetEntry.item, reply) : Promise.resolve({ ok: false, message: `${sheetBot.name} no longer asks this.` })} onClose={() => setOpen(null)} /> : null}
  </Screen>;
}

/** The newest question across the bots, answerable from here (23.08: "Approve and start", "Open"). */
function NewestQuestion({ entry, bot, now, connected, answering, error, onAnswer, onOpen }: { entry: NeedsYouEntry; bot: Bot; now: number; connected: boolean; answering: string | null; error?: string; onAnswer(index: number): void; onOpen(): void }) {
  const { palette } = useTheme();
  if (entry.kind === "item") {
    return <BotQuestionCard compact bot={bot} item={entry.item} asker={<Asker bot={bot} />} time={ago(entry.at, now)} busy={answering === `${entry.botId}:${entry.item.number}`} disabled={!connected || answering !== null} error={error} onAnswer={onAnswer} onOpen={onOpen} />;
  }
  return <Card style={[styles.agent, { borderColor: `${palette.warning}66` }]}>
    <View style={styles.agentHead}><Asker bot={bot} /><Text style={[styles.time, { color: palette.muted }]}>{ago(entry.at, now)}</Text></View>
    <Text style={[styles.agentQuestion, { color: palette.ink }]}>{entryQuestion(entry)}</Text>
    <Text numberOfLines={1} style={[styles.agentSession, { color: palette.muted }]}>{`In ${entry.sessionTitle}`}</Text>
    <Button label="Open" kind="secondary" onPress={onOpen} />
  </Card>;
}

/** A bot on the team: its mark, name and role, what it is doing and since when. */
function TeamRow({ bot, first, status, onPress }: { bot: Bot; first: boolean; status: ReturnType<typeof teamStatus>; onPress(): void }) {
  const { palette } = useTheme();
  const tone = status.tone === "needs" ? palette.warning : palette.muted;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${bot.name}, ${bot.roleTitle}. ${status.text}`} onPress={onPress}
    style={({ pressed }) => [styles.team, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.selected }]}>
    <BotAvatar bot={bot} size={40} dot={status.tone === "working" ? "working" : status.tone === "paused" ? "paused" : null} />
    <View style={styles.teamText}>
      <Text numberOfLines={1} style={[styles.teamName, { color: palette.ink }]}>{bot.name}<Text style={[styles.teamRole, { color: palette.muted }]}>{`  ${bot.roleTitle}`}</Text></Text>
      <Text numberOfLines={1} style={[styles.teamStatus, { color: tone }]}>{status.text}</Text>
    </View>
    {status.at ? <Text style={[styles.time, { color: palette.muted }]}>{status.at}</Text> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, minHeight: 52 },
  rowText: { flex: 1, fontSize: 15 },
  agent: { padding: 14, gap: 8 },
  agentHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  agentQuestion: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
  agentSession: { fontSize: 13 },
  team: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  teamText: { flex: 1, gap: 2 },
  teamName: { fontSize: 16, fontWeight: "600" },
  teamRole: { fontSize: 14, fontWeight: "400" },
  teamStatus: { fontSize: 14 },
  time: { fontSize: 13, fontVariant: ["tabular-nums"] },
  error: { fontSize: 13, textAlign: "center" },
});

// Laid out again when the text size changes while the app is open (PRO-601).
export default withTextSizePage(BotsScreen);
