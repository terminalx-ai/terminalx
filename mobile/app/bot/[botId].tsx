import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, ChevronRight, Clock, MessageSquare, Pause, Play } from "lucide-react-native";
import { ago, dutyOutcome, dutyWhen, type BotHome, type BotItem } from "@mobile/data/bots";
import { useApp } from "@mobile/state/AppProvider";
import { useBotHome, useNow } from "@mobile/state/bots";
import { botsOffDetail, useHostWords, type HostWords } from "@mobile/state/host-words";
import { connectionUsable, useConnectionState } from "@mobile/state/connection-view";
import { screenMessage } from "@mobile/transport/connection-errors";
import { BotAvatar, BotQuestionCard, BotSection, NeedsYouHeading, useBotAnswer } from "@mobile/ui/bots";
import { BotQuestionSheet } from "@mobile/ui/BotQuestionSheet";
import { GlassIconButton } from "@mobile/ui/glass";
import { Markdown } from "@mobile/ui/Markdown";
import { Card, EmptyState } from "@mobile/ui/primitives";
import { usePullRefresh } from "@mobile/ui/pull-refresh";
import { Spinner } from "@mobile/ui/Spinner";
import { useTheme } from "@mobile/ui/theme";

/** The same four parts as the desktop's bot view (23.08). */
const PARTS = ["Home", "Chat", "Duties", "Role"] as const;
type Part = (typeof PARTS)[number];

/** Where a bot "runs on", in words; a place a newer Mac writes is shown as itself. */
const runsOn = (place: string, words: HostWords) => place === "thisMac" ? words.This : place;

/**
 * A bot's home on the phone (23.08): Home, Chat, Duties and Role, with Pause
 * one tap away in the header. `item` opens that item's question as a sheet.
 */
export default function BotScreen() {
  const params = useLocalSearchParams<{ botId: string; name?: string; item?: string }>();
  const app = useApp();
  const words = useHostWords();
  const router = useRouter();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const host = app.activeHost;
  const home = useBotHome(app.api, host?.id, params.botId, app.connectionEpoch, app.sessions);
  const connected = connectionUsable(useConnectionState(app));
  const answers = useBotAnswer(app.api, () => void home.refresh());
  const pull = usePullRefresh(home.refresh);
  const [part, setPart] = useState<Part>("Home");
  const [open, setOpen] = useState<number | null>(() => params.item ? Number(params.item) : null);
  const [switching, setSwitching] = useState(false);
  const value = home.value;
  const bot = value?.bot;
  const name = bot?.name ?? params.name ?? "Bot";

  const togglePause = () => {
    if (!bot) return;
    const act = bot.paused ? app.api.resumeBot(bot.id) : app.api.pauseBot(bot.id);
    setSwitching(true);
    void act.then(() => home.refresh())
      .catch((cause: unknown) => Alert.alert(bot.paused ? `Could not resume ${bot.name}` : `Could not pause ${bot.name}`, screenMessage(cause, `Couldn’t reach ${words.the}. Try again once it is connected.`)))
      .finally(() => setSwitching(false));
  };
  const openChat = (sessionId: string, tabId: string | null, title: string) => {
    if (!host) return;
    router.push({ pathname: "/session/[sessionId]", params: { sessionId, ...(tabId ? { tabId } : {}), hostId: host.id, title } });
  };

  const sheetItem = open !== null ? value?.items.items.find((item) => item.number === open && item.state === "needsYou" && item.question) ?? null : null;

  return <View style={[styles.page, { backgroundColor: palette.page, paddingTop: insets.top }]}>
    <Stack.Screen options={{ title: name, headerShown: false }} />
    <View style={styles.header}>
      <GlassIconButton label="Back" icon={<ChevronLeft size={22} color={palette.ink} strokeWidth={1.8} />} onPress={() => router.back()} />
      {bot ? <BotAvatar bot={bot} size={36} /> : null}
      <View style={styles.titles}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{name}</Text>
        {bot ? <Text numberOfLines={1} style={[styles.role, { color: bot.paused ? palette.muted : sheetItem ? palette.warning : palette.muted }]}>{bot.paused ? `Paused · ${bot.roleTitle}` : `${bot.roleTitle} · ${runsOn(bot.runsOn, words)}`}</Text> : null}
      </View>
      {bot ? <GlassIconButton testID="bot-pause" label={bot.paused ? `Resume ${bot.name}` : `Pause ${bot.name}`} disabled={switching || !connected} icon={bot.paused ? <Play size={18} color={palette.ink} strokeWidth={1.8} /> : <Pause size={18} color={palette.ink} strokeWidth={1.8} />} onPress={togglePause} /> : null}
    </View>
    <View accessibilityRole="tablist" style={[styles.partsBar, { borderBottomColor: palette.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.parts}>
        {PARTS.map((each) => {
          const on = each === part;
          return <Pressable key={each} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setPart(each)} style={[styles.part, on && { borderBottomColor: palette.ink }]}>
            <Text style={[styles.partText, { color: on ? palette.ink : palette.muted, fontWeight: on ? "600" : "400" }]}>{each}</Text>
          </Pressable>;
        })}
      </ScrollView>
    </View>
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]} refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} tintColor={palette.accent} />}>
      {home.offered === false ? <EmptyState title="Bots are off" detail={botsOffDetail(app.activeHost?.platform)} />
        : !value ? home.error ? <EmptyState title="Bot unavailable" detail={home.error} /> : <EmptyState busy title={`Loading ${name}`} detail={`Reading from ${words.your}.`} />
        : part === "Home" ? <HomePart home={value} connected={connected} answering={answers.answering} errors={answers.errors} onAnswer={(item, index) => void answers.answer(value.bot, item, { answer: index })} onOpen={setOpen} onResume={togglePause} />
        : part === "Chat" ? <ChatPart home={value} onOpen={openChat} />
        : part === "Duties" ? <DutiesPart home={value} />
        : <RolePart home={value} />}
      {value && home.error ? <Text style={[styles.error, { color: palette.danger }]}>{home.error}</Text> : null}
    </ScrollView>
    {open !== null && bot ? <BotQuestionSheet bot={bot} item={sheetItem} connected={connected} busy={answers.answering === `${bot.id}:${open}`} error={answers.errors[`${bot.id}:${open}`]}
      onAnswer={(reply) => sheetItem ? answers.answer(bot, sheetItem, reply) : Promise.resolve({ ok: false, message: `${bot.name} no longer asks this.` })} onClose={() => setOpen(null)} /> : null}
  </View>;
}

function HomePart({ home, connected, answering, errors, onAnswer, onOpen, onResume }: { home: BotHome; connected: boolean; answering: string | null; errors: Record<string, string>; onAnswer(item: BotItem, index: number): void; onOpen(number: number): void; onResume(): void }) {
  const { palette } = useTheme();
  const items = home.items.items;
  const asking = items.filter((item) => item.state === "needsYou" && item.question);
  const working = items.filter((item) => item.state === "inProgress" || item.state === "waiting");
  const planned = items.filter((item) => item.state === "planned");
  const now = useNow();
  return <>
    {home.bot.paused ? <Card style={styles.paused}>
      <Text style={[styles.pausedText, { color: palette.ink }]}>{`Paused ${ago(home.bot.paused.at, now) === "now" ? "just now" : `${ago(home.bot.paused.at, now)} ago`}${home.bot.paused.by === "owner" ? " by you" : ""}. It starts no new work and its duties do not wake; it still answers you in its chat.`}</Text>
      <Pressable accessibilityRole="button" onPress={onResume} disabled={!connected} style={styles.resumeLink}><Text style={[styles.link, { color: palette.accent }]}>{`Resume ${home.bot.name}`}</Text></Pressable>
    </Card> : null}
    {asking.length ? <>
      <NeedsYouHeading count={asking.length} />
      {asking.map((item) => <BotQuestionCard key={item.number} bot={home.bot} item={item} busy={answering === `${home.bot.id}:${item.number}`} disabled={!connected || answering !== null} error={errors[`${home.bot.id}:${item.number}`]} onAnswer={(index) => onAnswer(item, index)} onOpen={() => onOpen(item.number)} />)}
    </> : null}
    {working.length ? <>
      <BotSection>{`In progress · ${working.length}`}</BotSection>
      <Card>{working.map((item, index) => <ItemRow key={item.number} item={item} first={index === 0} now={now} />)}</Card>
    </> : null}
    {planned.length ? <>
      <BotSection>{`Planned · ${planned.length}`}</BotSection>
      <Card>{planned.map((item, index) => <ItemRow key={item.number} item={item} first={index === 0} now={now} />)}</Card>
    </> : null}
    {!asking.length && !working.length && !planned.length ? <EmptyState title="Nothing open" detail={`${home.bot.name}'s open work and questions for you show here.`} /> : null}
  </>;
}

function ItemRow({ item, first, now }: { item: BotItem; first: boolean; now: number }) {
  const { palette } = useTheme();
  const last = item.lastActivity?.text;
  const when = ago(item.modified, now);
  return <View accessibilityLabel={`#${item.number} ${item.title}`} style={[styles.item, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}>
    {item.state === "inProgress" ? <Spinner size={18} color={palette.info} /> : <Clock size={18} color={palette.muted} strokeWidth={1.8} />}
    <View style={styles.itemText}>
      <Text numberOfLines={2} style={[styles.itemTitle, { color: palette.ink }]}>{item.title}</Text>
      <Text numberOfLines={1} style={[styles.itemMeta, { color: palette.muted }]}>{[item.state === "waiting" ? "Waiting" : last, when].filter(Boolean).join(" · ")}</Text>
    </View>
  </View>;
}

function ChatPart({ home, onOpen }: { home: BotHome; onOpen(sessionId: string, tabId: string | null, title: string): void }) {
  const words = useHostWords();
  const { palette } = useTheme();
  const now = useNow();
  if (!home.chats.length) return <EmptyState title="No chats yet" detail={`Open ${home.bot.name} on ${words.your} to start its home chat.`} />;
  return <Card>{home.chats.map((chat, index) => <Pressable key={chat.sessionId} accessibilityRole="button" accessibilityLabel={chat.home ? `Home chat, ${chat.title}` : chat.title} onPress={() => onOpen(chat.sessionId, chat.tabId, chat.title)}
    style={({ pressed }) => [styles.item, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }, pressed && { backgroundColor: palette.selected }]}>
    {chat.running ? <Spinner size={18} color={palette.info} /> : <MessageSquare size={18} color={palette.muted} strokeWidth={1.8} />}
    <View style={styles.itemText}>
      <Text numberOfLines={1} style={[styles.itemTitle, { color: palette.ink }]}>{chat.home ? "Home chat" : chat.title}</Text>
      <Text numberOfLines={1} style={[styles.itemMeta, { color: palette.muted }]}>{[chat.duty ? "Duty run" : chat.home ? "Where your answers go" : null, ago(chat.modified, now)].filter(Boolean).join(" · ")}</Text>
    </View>
    <ChevronRight size={16} color={palette.muted} />
  </Pressable>)}</Card>;
}

function DutiesPart({ home }: { home: BotHome }) {
  const words = useHostWords();
  const { palette } = useTheme();
  if (!home.duties.length) return <EmptyState title="No duties" detail={`Give ${home.bot.name} duties on ${words.your}: what wakes it, and when.`} />;
  return <>
    <Card>{home.duties.map((duty, index) => <View key={duty.id} accessibilityLabel={`${duty.name}, ${duty.enabled ? "on" : "off"}`} style={[styles.item, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border }]}>
      <View style={[styles.state, { backgroundColor: duty.enabled ? palette.success : palette.faint }]} />
      <View style={styles.itemText}>
        <Text numberOfLines={1} style={[styles.itemTitle, { color: palette.ink }]}>{duty.name}</Text>
        <Text numberOfLines={1} style={[styles.itemMeta, { color: palette.muted }]}>{[dutyWhen(duty), duty.enabled ? dutyOutcome(duty.lastOutcome) : "Off"].join(" · ")}</Text>
      </View>
    </View>)}</Card>
    <Text style={[styles.footnote, { color: palette.muted }]}>Duties are added and changed on {words.your}.</Text>
  </>;
}

function RolePart({ home }: { home: BotHome }) {
  const words = useHostWords();
  const { palette } = useTheme();
  if ("unreadable" in home.role) return <EmptyState title="Role unavailable" detail={home.role.unreadable} />;
  if (!home.role.text.trim()) return <EmptyState title="No role written" detail={`${home.bot.name}'s standing instructions show here.`} />;
  return <>
    <Card style={styles.roleCard}><Markdown text={home.role.text} /></Card>
    {home.role.cut ? <Text style={[styles.footnote, { color: palette.muted }]}>The rest is on {words.your}.</Text> : null}
    <Text style={[styles.footnote, { color: palette.muted }]}>The role is edited on {words.your}.</Text>
  </>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10 },
  titles: { flex: 1, gap: 1 },
  name: { fontSize: 18, fontWeight: "700" },
  role: { fontSize: 13 },
  partsBar: { borderBottomWidth: StyleSheet.hairlineWidth },
  parts: { flexDirection: "row", gap: 20, paddingHorizontal: 18 },
  part: { minHeight: 44, justifyContent: "center", paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  partText: { fontSize: 15 },
  content: { paddingHorizontal: 16, paddingTop: 12, gap: 12 },
  paused: { padding: 14, gap: 8 },
  pausedText: { fontSize: 14, lineHeight: 20 },
  resumeLink: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center" },
  link: { fontSize: 15, fontWeight: "600" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  itemText: { flex: 1, gap: 2 },
  itemTitle: { fontSize: 15, fontWeight: "500" },
  itemMeta: { fontSize: 13 },
  state: { width: 8, height: 8, borderRadius: 4 },
  roleCard: { padding: 14 },
  footnote: { fontSize: 13, textAlign: "center" },
  error: { fontSize: 13, textAlign: "center" },
});
