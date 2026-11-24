import { MoreHorizontal } from "lucide-react-native";
import { GlassIconButton } from "./glass";
import { showRowActions, type RowAction } from "./row-actions";
import { useTheme } from "./theme";

/**
 * The ••• in a workspace's header, beside Sharing (25.06): it opens the same
 * sheet a long press on the workspace's row does, under the workspace's
 * title. Drawn only for someone who has an action to take. `message` is a
 * line under the title on why something is not offered (25.10).
 */
export function WorkspaceActionsButton({ title, actions, disabled, message }: { title: string; actions: readonly RowAction[]; disabled?: boolean; message?: string }) {
  const { palette } = useTheme();
  if (!actions.length) return null;
  return <GlassIconButton testID="workspace-actions" label="Workspace actions" disabled={disabled} icon={<MoreHorizontal size={20} color={palette.ink} strokeWidth={1.8} />} onPress={() => showRowActions(title, actions, message)} />;
}
