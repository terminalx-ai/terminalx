import { Text, View } from "react-native";
import { Circle, CircleAlert, CircleDashed, CircleDot, CircleX, GitMerge, GitPullRequest, GitPullRequestDraft, LoaderCircle, ShieldAlert } from "lucide-react-native";
import { sessionStatus, statusText, statusTooltip, type SessionStatusInput } from "@terminalx/portable/sessionStatus";
import { useTheme } from "./theme";

// The same marks as the Mac (17.07): one glyph and colour per row label.
const icons: Record<string, typeof Circle> = {
  approval: ShieldAlert, attention: CircleAlert, working: LoaderCircle, pr: GitPullRequest, failing: CircleX,
  ready: GitMerge, draft: GitPullRequestDraft, merged: GitMerge, none: Circle, uncommitted: CircleDot, not_started: CircleDashed,
};
const MERGED = "#a371f7";

export function SessionStatus({ input }: { input: SessionStatusInput }) {
  const { palette } = useTheme();
  const status = sessionStatus(input);
  const colors: Record<string, string> = { accent: palette.accent, info: palette.info, del: palette.danger, add: palette.success, soft: palette.muted, merged: MERGED, faint: palette.faint };
  const color = colors[status.color] ?? palette.muted;
  const Icon = icons[status.icon] ?? Circle;
  // The full label, as the Mac's overview shows it ('Checks failing · PR #781'); the hint names the state behind it.
  return <View accessible accessibilityLabel={statusText(status)} accessibilityHint={statusTooltip(status)} style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 }}>
    <Icon size={13} color={color} />
    <Text style={{ color: palette.muted, fontSize: 13 }}>{statusText(status)}</Text>
  </View>;
}
