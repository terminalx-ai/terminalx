import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { Check } from "lucide-react-native";
import type { NewSessionOptions } from "@mobile/data/host-api";
import { agentDefaults, blocked, chooseModel, initialChoices, request, type NewSessionChoices } from "@mobile/data/new-session";
import { draftContent, draftIdFor, type DraftId } from "@mobile/data/draft-id";
import { useApp } from "@mobile/state/AppProvider";
import { Button, Card, EmptyState, Screen, SectionTitle } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

/** Start a session on the Mac, with the choices its new-session view offers. */
export default function NewSessionScreen() {
  const app = useApp();
  const router = useRouter();
  const { palette } = useTheme();
  const [options, setOptions] = useState<NewSessionOptions | null | undefined>(undefined);
  const [choices, setChoices] = useState<NewSessionChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The id this draft is started under (#675): a retry after a lost reply finds the first session.
  const draftId = useRef<DraftId | null>(null);

  useEffect(() => {
    let current = true;
    if (app.connectionStage !== "connected") return;
    app.api.newSessionOptions().then((value) => {
      if (!current) return;
      setOptions(value);
      if (value) setChoices((previous) => previous ?? initialChoices(value));
    }).catch((cause: unknown) => { if (current) { setOptions(null); setError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { current = false; };
  }, [app.api, app.connectionStage]);

  if (app.connectionStage !== "connected") return <Screen><EmptyState title="Connect to your Mac" detail="New sessions start on the Mac, over the encrypted connection." /></Screen>;
  if (options === undefined) return <Screen><EmptyState title="Loading" detail="Reading projects and agents from your Mac." busy /></Screen>;
  if (options === null || !choices) return <Screen><EmptyState title="Not available on this Mac" detail={error ?? "Update TerminalX on this Mac to start sessions from your phone."} /></Screen>;

  const agent = options.agents.find((candidate) => candidate.id === choices.agent) ?? null;
  const model = agent?.models.find((candidate) => candidate.id === choices.model) ?? null;
  const where = choices.where;
  const project = where && "projectId" in where ? options.projects.find((candidate) => candidate.id === where.projectId) ?? null : null;
  const reason = blocked(choices, options);
  const change = (patch: Partial<NewSessionChoices>) => setChoices({ ...choices, ...patch });

  const start = async () => {
    if (reason || busy) return;
    setBusy(true);
    setError(null);
    const content = draftContent("agent", JSON.stringify([choices.where, choices.agent, choices.model, choices.effort, choices.mode, choices.title, choices.text]), []);
    draftId.current = draftIdFor(draftId.current, content);
    try {
      const result = await app.api.createSession(request(choices), draftId.current.id);
      if (!result.created) { setError(result.message); return; }
      draftId.current = null;
      void app.refreshSessions();
      router.replace({ pathname: "/session/[sessionId]", params: { sessionId: result.sessionId, tabId: result.tabId, hostId: app.activeHost?.id ?? "", title: result.title } });
      if (result.sendError) setError(result.sendError);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const choice = (key: string, label: string, selected: boolean, onPress: () => void, detail?: string, disabled?: boolean) => <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={detail} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, { backgroundColor: selected ? palette.selected : palette.raised, opacity: disabled ? 0.5 : 1 }]}><View style={styles.flex}><Text style={[styles.choiceLabel, { color: palette.ink }]}>{label}</Text>{detail ? <Text style={[styles.detail, { color: palette.muted }]}>{detail}</Text> : null}</View>{selected ? <Check size={17} color={palette.accent} /> : null}</Pressable>;

  return <Screen>
    <SectionTitle>Where</SectionTitle>
    <Card style={styles.group}>
      {options.projects.map((candidate) => choice(candidate.id, candidate.name, project?.id === candidate.id, () => change({ where: { projectId: candidate.id, useWorktree: candidate.git } }), candidate.git ? undefined : "Folder"))}
      {choice("quick", "Quick chat", !!where && "quick" in where, () => change({ where: { quick: true } }), "No project")}
    </Card>
    {project?.git && where && "projectId" in where ? <Card style={styles.group}>
      {choice("worktree", "New worktree", where.useWorktree, () => change({ where: { ...where, useWorktree: true } }), "A branch of its own")}
      {choice("main", "On the checkout", !where.useWorktree, () => change({ where: { ...where, useWorktree: false } }), "Works in the project's folder")}
    </Card> : null}

    <SectionTitle>Agent</SectionTitle>
    <Card style={styles.group}>{options.agents.map((candidate) => choice(candidate.id, candidate.name, candidate.id === choices.agent, () => change(agentDefaults(candidate)), candidate.available ? undefined : `Not installed · ${candidate.installHint}`, !candidate.available))}</Card>
    {agent && agent.models.length ? <><SectionTitle>Model</SectionTitle><Card style={styles.group}>{agent.models.map((candidate) => choice(candidate.id, candidate.label, candidate.id === choices.model, () => setChoices(chooseModel(choices, agent, candidate.id))))}</Card></> : null}
    {agent?.effort && model && model.efforts.length ? <><SectionTitle>Effort</SectionTitle><Card style={styles.row}>{model.efforts.map((effort) => <Pressable key={effort} accessibilityRole="button" accessibilityState={{ selected: effort === choices.effort }} onPress={() => change({ effort })} style={[styles.pill, { backgroundColor: effort === choices.effort ? palette.selected : palette.raised }]}><Text style={[styles.choiceLabel, { color: palette.ink }]}>{effort}</Text></Pressable>)}</Card></> : null}
    {agent?.permissionModes !== false ? <><SectionTitle>Permissions</SectionTitle><Card style={styles.group}>{options.modes.map((mode) => choice(mode.id, mode.label, mode.id === choices.mode, () => change({ mode: mode.id })))}</Card></> : null}
    {agent?.id === "codex" && options.nativeCodex ? <Text style={[styles.detail, styles.note, { color: palette.muted }]}>Native Codex is on for this Mac: unless you choose Ask every time, the session connects to Codex directly.</Text> : null}

    <SectionTitle>First message</SectionTitle>
    <Card style={styles.block}>
      <TextInput accessibilityLabel="Session title" value={choices.title} onChangeText={(title) => change({ title })} placeholder="Title (optional)" placeholderTextColor={palette.faint} style={[styles.input, { color: palette.ink, borderColor: palette.border }]} />
      <TextInput accessibilityLabel="First message" value={choices.text} onChangeText={(text) => change({ text })} placeholder="What should the agent do?" placeholderTextColor={palette.faint} multiline style={[styles.input, styles.message, { color: palette.ink, borderColor: palette.border }]} />
    </Card>
    {error ? <Text accessibilityRole="alert" style={[styles.detail, styles.note, { color: palette.danger }]}>{error}</Text> : null}
    <Button label={busy ? "Starting…" : "Start session"} disabled={!!reason || busy} onPress={() => void start()} />
    {reason && choices.text.trim() ? <Text style={[styles.detail, styles.note, { color: palette.muted }]}>{reason}</Text> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  group: { padding: 6, gap: 4 },
  row: { padding: 8, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  block: { padding: 12, gap: 10 },
  choice: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  choiceLabel: { fontSize: 15, fontWeight: "600" },
  pill: { minHeight: 40, paddingHorizontal: 14, borderRadius: 10, justifyContent: "center" },
  detail: { fontSize: 13, lineHeight: 18 },
  note: { paddingHorizontal: 4 },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, fontSize: 16 },
  message: { minHeight: 120, paddingTop: 10, textAlignVertical: "top" },
});
