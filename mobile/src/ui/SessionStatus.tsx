import { Text, View } from "react-native";
import { Check, Circle, CircleAlert, Clock, FileText, GitBranch, GitMerge, GitPullRequest, GitPullRequestDraft, ListOrdered, Loader, MessageCircleQuestion, ShieldQuestion, Square, TriangleAlert } from "lucide-react-native";
import { sessionStatus, type SessionStatusInput } from "@terminalx/portable/sessionStatus";
import { useTheme } from "./theme";

const icons: Record<string, typeof Circle> = { shield: ShieldQuestion, question: MessageCircleQuestion, plan: FileText, error: CircleAlert, attention: TriangleAlert, stop: Square, loader: Loader, working: Loader, clock: Clock, merged: GitMerge, conflict: TriangleAlert, draft: GitPullRequestDraft, queue: ListOrdered, check: Check, pr: GitPullRequest, branch: GitBranch, circle: Circle };

export function SessionStatus({ input }: { input: SessionStatusInput }) {
  const { palette } = useTheme();
  const status = sessionStatus(input);
  const colors: Record<string, string> = { warning: palette.warning, destructive: palette.danger, info: palette.accent, success: palette.success, merged: palette.success, muted: palette.muted };
  const color = colors[status.color];
  const Icon = icons[status.icon] ?? Circle;
  return <View accessible accessibilityLabel={status.label} accessibilityHint={status.tooltip} style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 }}>
    <Icon size={13} color={color} />
    <Text style={{ color, fontSize: 13 }}>{status.label}</Text>
  </View>;
}
