import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text } from "react-native";
import type { WorkspaceDisposition } from "@terminalx/portable/workspace";
import { useApp } from "@mobile/state/AppProvider";
import { useTheme } from "@mobile/ui/theme";

/** Paired local workspace removal uses the host's shared safety check. */
export function SessionDeleteButton({ sessionId, title, onDeleted }: { sessionId: string; title: string; onDeleted(): void }) {
  const app = useApp();
  const { palette } = useTheme();
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const remove = async (workspace: boolean, confirmedUnsafe = false) => {
    if (!live.current) return;
    setBusy(true);
    try {
      const outcome = await app.api.deleteSession(sessionId, workspace, confirmedUnsafe);
      if (outcome?.keptBranch || outcome?.rescuedBranch) {
        Alert.alert("Branch kept", [outcome.keptBranch ? `The branch ${outcome.keptBranch} was kept.` : "", outcome.rescuedBranch ? `Detached work was saved on ${outcome.rescuedBranch}.` : ""].filter(Boolean).join("\n"));
      }
      await app.refreshSessions();
      onDeleted();
    } catch (e) { Alert.alert("Could not delete session", String(e)); }
    finally { setBusy(false); }
  };

  const confirmWorkspace = (d: WorkspaceDisposition) => {
    if (d.safe) { void remove(true); return; }
    Alert.alert("Confirm permanent removal", workspaceWarning(d), [
      { text: "Cancel", style: "cancel" },
      { text: "Delete anyway", style: "destructive", onPress: () => void remove(true, true) },
    ]);
  };

  const open = async () => {
    setBusy(true);
    let d: WorkspaceDisposition | null = null;
    try { d = await app.api.workspaceDisposition(sessionId); }
    catch { /* Session-only deletion needs no workspace check. */ }
    finally { setBusy(false); }
    if (!live.current) return;
    const last = d && !d.isMain && d.sessions === 1 ? d : null;
    Alert.alert(`Delete "${title}"?`, "Only this session and its transcripts and attachments are deleted."
      + (last ? `\n\nAlso deleting its workspace permanently removes the directory and local branch.\n${workspaceWarning(last)}`
        : " The workspace will remain on disk."), [
      { text: "Cancel", style: "cancel" },
      { text: "Delete session only", style: "destructive", onPress: () => void remove(false) },
      ...(last ? [{ text: "Also delete workspace", style: "destructive" as const, onPress: () => confirmWorkspace(last) }] : []),
    ]);
  };

  return <Pressable accessibilityRole="button" accessibilityLabel="Delete session" disabled={busy || app.connectionStage !== "connected"} onPress={() => void open()}>
    <Text style={{ color: palette.danger, padding: 8 }}>{busy ? "Checking…" : "Delete"}</Text>
  </Pressable>;
}

export function workspaceWarning(d: WorkspaceDisposition): string {
  return [
    `Branch: ${d.branch ?? "detached / unknown"}; pushed: ${d.pushed == null ? "not verified" : d.pushed ? "yes" : "no"}.`,
    d.checked ? `${d.uncommitted} uncommitted or untracked files will be lost.` : "Uncommitted files could not be checked.",
    d.merged ? `Merged into ${d.defaultBranch}.` : `${d.aheadOfBase ?? "Unknown number of"} commits not in ${d.defaultBranch ?? "the default branch"}.`,
    d.checked ? `${d.stashes} repository stash entries (kept; Git cannot reliably identify their workspace).` : "Stash entries could not be checked.",
    d.pr ? `PR #${d.pr.number} is ${d.pr.state}: ${d.pr.url}` : d.prChecked ? "" : "Pull request status could not be checked.",
    d.verificationError ? `Not verified: ${d.verificationError}` : "",
    d.safe ? "Merged and clean." : "Deleting the local branch removes its reference to unmerged commits.",
  ].filter(Boolean).join("\n");
}
