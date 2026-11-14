import { Pressable, StyleSheet, Text, View } from "react-native";
import { manualStatusLabel } from "@terminalx/portable/manualStatus";
import { shortTime, type ChatRow } from "@mobile/data/session-list";
import { BotFace } from "./BotFace";
import { StateMark } from "./MacIcon";
import { SessionStatus } from "./SessionStatus";
import { useTheme } from "./theme";

const STATE_WORDS = { needs: "needs you", working: "working", done: "" } as const;
const PROJECT_CHARS = 10;

/** A project's name, short enough to lead a row's title without crowding its branch. */
export function shortProject(project: string): string {
  return project.length > PROJECT_CHARS ? `${project.slice(0, PROJECT_CHARS - 1).trimEnd()}…` : project;
}

/** A chat as a messaging app lists it: its face, project/branch (else its title) and when, and what was last said. */
export function ChatListRow({ row, onPress }: { row: ChatRow; onPress(): void }) {
  const { palette } = useTheme();
  const state = STATE_WORDS[row.state];
  const manualStatus = manualStatusLabel(row.session.manualStatus);
  const unread = row.unread ? "Unread" : "";
  // Which project, then which branch: a quick chat has no project to name.
  const project = row.session.kind === "quick" || !row.session.project ? null : shortProject(row.session.project);
  return <Pressable accessibilityRole="button" accessibilityLabel={[row.name, row.session.kind === "quick" ? "" : row.session.project, manualStatus, state, unread, row.preview].filter(Boolean).join(", ")} onPress={onPress} style={({ pressed }) => [styles.chat, pressed && { backgroundColor: palette.raised }]}>
    <BotFace seed={row.session.id} color={row.color} size={48} />
    <View style={styles.body}>
      <View style={styles.line}>
        <Text numberOfLines={1} style={[styles.title, { color: palette.ink }]}>{project ? <Text style={{ color: palette.muted }}>{project}/</Text> : null}{row.name}</Text>
        <Text style={[styles.time, { color: palette.faint }]}>{shortTime(row.time)}</Text>
      </View>
      <View style={styles.line}>
        <Text numberOfLines={1} style={[styles.preview, { color: palette.muted }]}>{[manualStatus, unread].filter(Boolean).join(" · ")}{row.preview ? ` · ${row.preview}` : ""}</Text>
        <StateMark state={row.state} info={palette.info} warning={palette.warning} />
      </View>
      {/* The one detailed status the Mac decides for this session: agent attention first, then its PR. */}
      <SessionStatus input={row.session.rowStatus ?? row.session} />
    </View>
  </Pressable>;
}

// Space and type after the best chat apps: a 48pt face, rows about 80pt tall,
// titles in regular weight, and greys that step back.
const styles = StyleSheet.create({
  chat: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingVertical: 16 },
  body: { flex: 1, gap: 4 },
  line: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: "400", letterSpacing: -0.3 },
  preview: { flex: 1, fontSize: 15, lineHeight: 20, letterSpacing: -0.1 },
  time: { fontSize: 13, letterSpacing: -0.1, fontVariant: ["tabular-nums"] },
});
