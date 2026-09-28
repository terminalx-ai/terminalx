import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { SessionSummary } from "@mobile/data/host-api";
import { agentConversations, type AgentConversation } from "@mobile/data/session-navigation";
import { StatusDot } from "./primitives";
import { useTheme } from "./theme";

export function ConversationPicker({ session, selectedTabId, onSelect, horizontal = false }: {
  session: SessionSummary;
  selectedTabId?: string;
  onSelect(conversation: AgentConversation): void;
  horizontal?: boolean;
}) {
  const { palette } = useTheme();
  const conversations = agentConversations(session);
  const buttons = conversations.map((conversation) => {
    const selected = conversation.id === selectedTabId;
    const color = conversation.status === "waiting" ? palette.warning
      : conversation.status === "in_progress" ? palette.accent
      : conversation.status === "completed" ? palette.success : palette.faint;
    const status = conversation.status === "waiting" ? "Needs you"
      : conversation.status === "in_progress" ? "Working"
      : conversation.status === "completed" ? "Done" : "Idle";
    return <Pressable
      key={conversation.id}
      accessibilityRole="button"
      accessibilityLabel={`Open ${conversation.label}`}
      accessibilityHint={`${status} · ${session.title}`}
      accessibilityState={{ selected }}
      onPress={() => onSelect(conversation)}
      style={({ pressed }) => [styles.button, horizontal ? styles.chip : styles.row, {
        borderColor: palette.border,
        backgroundColor: selected ? palette.selected : pressed ? palette.raised : palette.card,
      }]}
    >
      <StatusDot color={color} />
      <View style={styles.label}>
        <Text numberOfLines={1} style={[styles.name, { color: palette.ink }]}>{conversation.label}</Text>
        <Text style={[styles.status, { color }]}>{status}</Text>
      </View>
      {!horizontal ? <ChevronRight size={18} color={palette.faint} /> : null}
    </Pressable>;
  });
  if (horizontal) return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.chips}>{buttons}</ScrollView>;
  return <View>{buttons.length ? buttons : <Text style={[styles.empty, { color: palette.muted }]}>No agent conversations</Text>}</View>;
}

const styles = StyleSheet.create({
  button: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 9 },
  row: { borderTopWidth: StyleSheet.hairlineWidth },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, minWidth: 140, maxWidth: 260 },
  label: { flex: 1, gap: 2 },
  name: { fontSize: 14, fontWeight: "600" },
  status: { fontSize: 12 },
  empty: { padding: 14, paddingTop: 0, fontSize: 13 },
  scroll: { flexGrow: 0, flexShrink: 0 },
  chips: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
});
