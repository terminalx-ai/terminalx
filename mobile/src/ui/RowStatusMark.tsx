import { Check, Circle, CircleQuestionMark, ShieldAlert, TriangleAlert } from "lucide-react-native";
import type { RowMark } from "@mobile/data/session-list";
import { Spinner } from "./Spinner";
import type { Palette } from "./theme";

/** The colour each mark and its words take (22.04): blue work, amber waits, green done, red failure, grey rest. */
export function markColor(mark: RowMark, palette: Palette): string {
  if (mark === "working") return palette.info;
  if (mark === "answer" || mark === "approval") return palette.warning;
  if (mark === "done") return palette.success;
  if (mark === "failed") return palette.danger;
  return palette.faint;
}

/** A session's or a tab's status mark. Decorative: the row reads its status in words. */
export function RowStatusMark({ mark, palette, size = 20 }: { mark: RowMark; palette: Palette; size?: number }) {
  const color = markColor(mark, palette);
  if (mark === "working") return <Spinner size={size - 2} color={color} />;
  const Icon = { answer: CircleQuestionMark, approval: ShieldAlert, done: Check, failed: TriangleAlert, idle: Circle }[mark];
  return <Icon size={size} color={color} strokeWidth={2} />;
}
