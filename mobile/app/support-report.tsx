import { useEffect, useRef, useState } from "react";
import { Linking, Platform, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { usePreventRemove, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  canSubmitReport, coverageLabel, features, localReportSource, prepareReport, reportExport, reportWindows, sourceLabels, supportConsole, supportError, supportReference, symptoms,
  type PreparedReport, type Problem, type ReportHours,
} from "@terminalx/portable/supportReports";
import { appVersion } from "@mobile/state/app-version";
import { useApp } from "@mobile/state/AppProvider";
import { supportApi } from "@mobile/support/api";
import { scopedConnectionSnapshot, supportConnectionClassifications, supportConnectionStages } from "@mobile/transport/connection";
import { supportPairingsCurrent, type SupportPairing } from "@mobile/store/pairing-instance";
import { readHosts } from "@mobile/store/hosts";
import { Button, Card, Screen } from "@mobile/ui/primitives";
import { useTheme } from "@mobile/ui/theme";

// Retain the exact attempted submission and its receipt across navigation.
let pendingReport: {
  owner: string;
  preview: PreparedReport;
  pairings: readonly SupportPairing[];
  problem: Problem;
  attach: boolean;
  reference: string;
  receipt?: string;
} | undefined;

export default function SupportReportScreen() {
  const app = useApp();
  return <ReportForm key={app.session?.user.userId ?? "signed-out"} />;
}

function ReportForm() {
  const router = useRouter();
  const app = useApp();
  const { palette } = useTheme();
  const owner = app.session?.user.userId;
  const [previous] = useState(() => pendingReport?.owner === owner ? pendingReport : undefined);
  const [problem, setProblem] = useState<Problem>(previous?.problem ?? { feature: "connection", symptom: "failed" });
  const [hours, setHours] = useState<ReportHours>(24);
  const [attach, setAttach] = useState(previous?.attach ?? false);
  const [reference, setReference] = useState(previous?.reference ?? "");
  const [local, setLocal] = useState(false);
  const [server, setServer] = useState(false);
  const [storedPreview, setPreview] = useState<PreparedReport | undefined>(previous?.preview);
  const [pairings, setPairings] = useState<readonly SupportPairing[]>(previous?.pairings ?? []);
  const revoked = Boolean(storedPreview) && !supportPairingsCurrent(app.hosts, owner, pairings);
  const preview = revoked ? undefined : storedPreview;
  const [receipt, setReceipt] = useState<string | undefined>(previous?.receipt);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(Boolean(previous));
  const [detail, setDetail] = useState(false);
  const active = useRef(false);
  usePreventRemove(busy);

  function resetPairingDraft() {
    setPreview(undefined);
    setPairings([]);
    setDetail(false);
    setAttempted(false);
    setMessage(supportError("support_pairing_changed"));
  }

  if (revoked && !receipt) resetPairingDraft();

  useEffect(() => {
    const pending = pendingReport;
    if (pending && pending.owner === owner && !pending.receipt && !supportPairingsCurrent(app.hosts, owner, pending.pairings)) {
      pendingReport = undefined;
    }
  }, [app.hosts, owner]);

  async function authorizePairings() {
    if (pairings.length && !supportPairingsCurrent(await readHosts(), owner, pairings)) {
      throw new Error("support_pairing_changed");
    }
  }

  async function run(action: () => Promise<void>, context: "preview" | "submit" | "copy" = "submit") {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setMessage(undefined);
    try { await action(); }
    catch (cause) {
      if (cause instanceof Error && cause.message === "support_pairing_changed") {
        if (pendingReport?.owner === owner && !pendingReport?.receipt) pendingReport = undefined;
        resetPairingDraft();
        return;
      }
      if (cause instanceof Error && cause.message === "support_preview_expired") {
        if (pendingReport?.owner === owner) pendingReport = undefined;
        setPreview(undefined);
        setAttempted(false);
      }
      setMessage(supportError(cause, context));
    }
    finally { active.current = false; setBusy(false); }
  }

  const prepare = () => run(async () => {
    const input = attach ? { reference: reference.trim().toLowerCase(), server: false as const } : { to: Date.now(), hours, server };
    const metadata = { appVersion: appVersion(), platform: Platform.OS };
    let contributors: readonly SupportPairing[] = [];
    const prepared = await prepareReport(input, (request) => supportApi.preview(owner, request), (window) => {
      const snapshot = local && owner ? scopedConnectionSnapshot(app.logs, owner, app.hosts, window) : undefined;
      contributors = snapshot?.pairings ?? [];
      return localReportSource(metadata, window, supportConnectionStages,
        snapshot?.events ?? (local ? "unavailable" : "omitted"), supportConnectionClassifications, snapshot?.retainedSince);
    }, metadata);
    setPairings(contributors);
    setPreview(prepared);
    setMessage(prepared.error);
  }, "preview");

  const submit = () => run(async () => {
    if (!preview?.key || !owner || !canSubmitReport(preview, attach)) return;
    const pending = { owner, preview, pairings, problem, attach, reference, receipt: undefined as string | undefined };
    pendingReport = pending;
    setAttempted(true);
    const result = await supportApi.submit(owner, { v: 1, key: preview.key, problem: attach ? undefined : problem, local: preview.local }, authorizePairings);
    if (!supportReference.test(result.reference)) throw new Error("unavailable");
    pending.receipt = result.reference;
    setReceipt(result.reference);
  });

  const coverage = preview && coverageLabel(preview.local, preview);
  const label = (value: string) => <Text style={{ color: palette.ink }}>{value}</Text>;

  return <Screen>
    <Card style={styles.card}>
      {label("TerminalX Support keeps reports for 30 days. Each report identifies this app’s version and platform.")}
      {receipt ? <>
        <Text selectable accessibilityRole="alert" style={{ color: palette.ink }}>Report delivered. Support reference {receipt}</Text>
        {label("To include another device, open Send a support report on that device and enter this reference under Add to a report.")}
        <Button label="Copy reference" kind="secondary" onPress={() => void Clipboard.setStringAsync(receipt)} />
        <Button label="Manage report" kind="secondary" onPress={() => {
          void Linking.openURL(supportConsole).catch(() => setMessage("Open Support reports at console.terminalx.ai to manage this report."));
        }} />
        {message && <Text accessibilityRole="alert" style={{ color: palette.ink }}>{message}</Text>}
        <Button label="Done" onPress={() => { if (pendingReport?.owner === owner) pendingReport = undefined; router.back(); }} />
      </> : <>
        {!preview && <>
          <Option label="Add to a report" value={attach} onChange={setAttach} disabled={busy} />
          {attach ? <TextInput accessibilityLabel="Support reference" placeholder="Support reference" placeholderTextColor={palette.muted} value={reference} onChangeText={setReference} maxLength={36} autoCapitalize="none" autoCorrect={false} editable={!busy} style={[styles.input, { borderColor: palette.border, color: palette.ink }]} /> : <>
            <Choices title="Feature" options={features} value={problem.feature} onChange={(feature) => setProblem({ ...problem, feature })} disabled={busy} />
            <Choices title="What happened?" options={symptoms} value={problem.symptom} onChange={(symptom) => setProblem({ ...problem, symptom })} disabled={busy} />
            <Choices title="Time window" options={reportWindows} value={hours} onChange={setHours} display={(value) => value === 1 ? "1 hour" : value === 24 ? "24 hours" : "7 days"} disabled={busy} />
          </>}
          <Option label="This phone’s connection events" value={local} onChange={setLocal} disabled={busy} />
          {!attach && <Option label="Server events for this account" value={server} onChange={setServer} disabled={busy} />}
          {label("Times, app versions, and event types can reveal when you used TerminalX. Prompts, raw logs, and terminal output are excluded.")}
          <Button label="Prepare preview" disabled={busy || (attach && !supportReference.test(reference.trim().toLowerCase()))} onPress={() => void prepare()} />
        </>}
        {preview && <>
          {label(`${new Date(preview.from).toISOString()} to ${new Date(preview.to).toISOString()}`)}
          {!attach && label(`Problem: ${problem.feature} · ${problem.symptom}`)}
          {label(`Phone: ${sourceLabels[preview.local.status]}${preview.local.truncated ? " (limited to newest events)" : ""}`)}
          {coverage && label(coverage)}
          {attach && !canSubmitReport(preview, attach) && label("This attachment needs device events. Edit the draft to select this phone’s connection events.")}
          {!attach && label("Desktop: Add from the other device after sending")}
          {label(`Account server events: ${attach ? "Unchanged from the original report" : sourceLabels[preview.server.status]}${preview.server.truncated ? " (limited to newest events)" : ""}`)}
          {label("Phone events cover this running app. Organization and relay service events are unavailable.")}
          <Button label={detail ? "Hide diagnostic fields" : "Review diagnostic fields"} kind="secondary" onPress={() => setDetail(!detail)} />
          {detail && <Text selectable style={{ color: palette.ink }}>{JSON.stringify({ mobile: preview.local, ...(!attach && { server: preview.server }) }, null, 2)}</Text>}
          {!attempted && <Button label="Edit draft" kind="secondary" disabled={busy} onPress={() => { setPreview(undefined); setMessage(undefined); setDetail(false); }} />}
          <Button label="Copy local report" kind="secondary" disabled={busy} onPress={() => void run(async () => {
            await authorizePairings();
            if (!await Clipboard.setStringAsync(reportExport("mobile", preview, attach ? undefined : problem, preview.local))) throw new Error("unavailable");
            setMessage("Reviewed local report copied. Share it only with the intended recipient.");
          }, "copy")} />
          <Button label={attempted ? "Retry same report" : "Send to TerminalX Support"} disabled={busy || !canSubmitReport(preview, attach)} onPress={() => void submit()} />
        </>}
        {message && <Text accessibilityRole="alert" style={{ color: palette.ink }}>{message}</Text>}
        <Button label={attempted ? "Close" : "Cancel"} kind="secondary" disabled={busy} onPress={() => router.back()} />
      </>}
    </Card>
  </Screen>;
}

function Option({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled: boolean }) {
  const { palette } = useTheme();
  return <View style={styles.option}>
    <Text style={[styles.optionLabel, { color: palette.ink }]}>{label}</Text>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} disabled={disabled} />
  </View>;
}

function Choices<T extends string | number>({ title, options, value, onChange, disabled, display = (entry) => String(entry).replace("-", " ") }: {
  title: string; options: readonly T[]; value: T; onChange: (value: T) => void; disabled: boolean; display?: (value: T) => string;
}) {
  const { palette } = useTheme();
  return <View style={styles.choices}>
    <Text style={{ color: palette.ink }}>{title}</Text>
    <View style={styles.buttons}>{options.map((option) => <Button key={option} label={display(option)} size="small" kind={value === option ? "primary" : "secondary"} disabled={disabled} accessibilityState={{ selected: value === option }} onPress={() => onChange(option)} />)}</View>
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14 },
  input: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, minHeight: 44, padding: 8 },
  option: { flexDirection: "row", alignItems: "center", gap: 12 },
  optionLabel: { flex: 1 },
  choices: { gap: 6 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
