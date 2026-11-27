import { useEffect, useRef, useState } from "react";
import { useAutomationFence, useAutomationScope } from "@/components/cloud/CloudAutomationScope";
import { OrganizationAutomationEditor, openSchedulesDialog, type OrganizationAutomationDraft } from "@/components/cloud/CloudSchedulesDialog";
import { Segmented } from "@/components/ui/controls";
import { api, type CloudAutomationDto } from "@/lib/api";
import { describeTiming, runText, scheduleErrorMessage, whenText } from "@/lib/cloudSchedules";

import { Button } from "@/components/ui/button";
import { confirmInApp } from "@/lib/confirm";
import { WebhookSecretDialog } from "@/components/cloud/WebhookDetails";
import { copyText } from "@/lib/clipboard";
import { consoleUrl } from "@/lib/consoleUrl";
import { errorCode } from "@/lib/cloudTerminals";
import { showError } from "@/lib/errorToasts";

type Scope = "all" | "local" | "cloud";

interface LocalRow {
  id: string;
  name: string;
  trigger: string;
  paused: boolean;
}

interface Props {
  organizationId: string;
  listVersion: number;
  locals: LocalRow[];
  localLoading: boolean;
  onSelectLocal: (id: string) => void;
}

export function OrganizationAutomationsList(props: Props) {
  const { stamp, allowed } = useAutomationScope();
  return <ScopedList key={JSON.stringify([stamp, props.organizationId, allowed])} {...props} cloudAllowed={allowed} />;
}

function cloudTrigger(row: CloudAutomationDto): string {
  if (row.githubTrigger) return "GitHub";
  if (row.webhookTrigger) return "Webhook";
  return row.schedule ? describeTiming(row.schedule) : "—";
}

function ScopedList({ organizationId, listVersion, locals, localLoading, onSelectLocal, cloudAllowed }: Props & { cloudAllowed: boolean }) {
  const [scope, setScope] = useState<Scope>("all");
  const [cloud, setCloud] = useState<CloudAutomationDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const capture = useAutomationFence();

  useEffect(() => {
    if (!cloudAllowed) return;
    const current = capture();
    setLoaded(false);
    setFailed(false);
    setCloud([]);
    let active = true;
    void api.cloudAutomations(null, organizationId).then(({ schedules }) => {
      if (active && current()) {
        setCloud(schedules);
        setLoaded(true);
      }
    }, () => {
      if (active && current()) setFailed(true);
    });
    return () => { active = false; };
  }, [capture, cloudAllowed, organizationId, listVersion, refreshVersion]);

  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const attempts = useRef(new Map<string, string>());
  const runNow = async (row: CloudAutomationDto) => {
    const current = capture();
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    setRunning(row.id);
    try {
      const confirmed = await confirmInApp({
        title: `Run “${row.name}” now?`,
        body: "This run can start billed cloud compute.",
        action: "Run now",
      });
      if (!confirmed || !current()) return;
      const key = attempts.current.get(row.id) ?? crypto.randomUUID();
      attempts.current.set(row.id, key);
      setNotice(null);
      const receipt = await api.cloudAutomationRunNow(organizationId, row.id, key, true);
      if (!current()) return;
      attempts.current.delete(row.id);
      setCloud((rows) => rows.map((entry) => entry.id === row.id ? { ...entry, lastRun: receipt.run } : entry));
      setNotice(receipt.duplicate ? "The run was already requested." : "Automation run requested.");
    } catch (error) {
      if (current()) showError("Could not run the automation", error);
    } finally {
      inFlight.current = false;
      if (current()) setRunning(null);
    }
  };

  const [draft, setDraft] = useState<OrganizationAutomationDraft | null>(null);
  const [opening, setOpening] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const beginDraft = async (row: CloudAutomationDto, kind: OrganizationAutomationDraft["kind"]) => {
    const current = capture();
    if (inFlight.current || !current()) return;
    inFlight.current = true;
    setOpening(true);
    setEditError(null);
    try {
      const editable = await api.cloudAutomationEdit(organizationId, row.id);
      if (current()) setDraft({ ...editable, kind });
    } catch (error) {
      if (current()) setEditError(scheduleErrorMessage(errorCode(error)));
    } finally {
      inFlight.current = false;
      if (current()) setOpening(false);
    }
  };
  const copyLink = async (link: string) => {
    const current = capture();
    if (!current()) return;
    setEditError(null);
    try {
      await copyText(link);
      if (current()) setNotice("Automation link copied.");
    } catch {
      if (current()) setEditError("Could not copy the automation link.");
    }
  };
  const saveDraft = (schedule: CloudAutomationDto, secret?: string) => {
    setCloud((rows) => rows.some((row) => row.id === schedule.id)
      ? rows.map((row) => row.id === schedule.id ? schedule : row)
      : [...rows, schedule]);
    if (draft?.kind === "duplicate") setRefreshVersion((version) => version + 1);
    setNotice(draft?.kind === "edit" ? "Automation saved." : "Automation duplicated.");
    setDraft(null);
    setCreatedSecret(secret ?? null);
  };

  const displayLocal = scope !== "cloud";
  const displayCloud = scope !== "local";
  const rows = [
    ...(displayLocal ? locals.map((row) => ({ ...row, key: `local:${row.id}`, by: "—", source: "This Mac", run: undefined, latestRun: undefined, edit: undefined, duplicate: undefined, link: undefined, open: () => onSelectLocal(row.id) })) : []),
    ...(displayCloud ? cloud.map((row) => ({
      key: `cloud:${row.id}`,
      name: row.name,
      paused: row.state === "paused",
      trigger: cloudTrigger(row),
      by: row.creator?.displayName?.trim() || "—",
      source: "Cloud",
      latestRun: row.lastRun ? { label: runText(row.lastRun), at: whenText(row.lastRun.startedAt ?? row.lastRun.scheduledFor) } : undefined,
      edit: Number.isSafeInteger(row.updatedAt) ? () => void beginDraft(row, "edit") : undefined,
      duplicate: Number.isSafeInteger(row.updatedAt) ? () => void beginDraft(row, "duplicate") : undefined,
      link: (() => {
        const url = consoleUrl(row.consoleUrl);
        return url ? () => void copyLink(url) : undefined;
      })(),
      run: row.state === "active" ? () => void runNow(row) : undefined,
      open: () => {
        if (capture()()) openSchedulesDialog({ orgId: organizationId, workspaceId: row.workspaceId, name: "Cloud workspace" });
      },
    })) : []),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
      <Segmented<Scope> aria-label="Automation scope" value={scope} onChange={setScope} options={[
        { value: "all", label: "All" },
        { value: "local", label: "This Mac" },
        { value: "cloud", label: "Cloud" },
      ]} />
      {draft && <OrganizationAutomationEditor orgId={organizationId} draft={draft} onClose={() => setDraft(null)} onSaved={saveDraft} />}
      {createdSecret && <WebhookSecretDialog secret={createdSecret} onClose={() => setCreatedSecret(null)} />}
      {editError && <p role="alert" className="mt-3 text-sm text-destructive">{editError}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
      {displayCloud && (!cloudAllowed || failed) && <p role="status" className="mt-3 text-sm text-muted-foreground">Cloud automations unavailable.</p>}
      {((displayLocal && localLoading) || (displayCloud && cloudAllowed && !loaded && !failed))
        && <p role="status" className="mt-3 text-sm text-muted-foreground">Reading automations…</p>}
      {rows.length > 0 && (
        <table className="mt-3 w-full table-fixed text-left text-xs">
          <thead>
            <tr className="border-b border-hairline text-muted-foreground">
              <th scope="col" className="w-1/2 px-2 py-2 font-medium">Automation</th>
              <th scope="col" className="px-2 py-2 font-medium">Trigger</th>
              <th scope="col" className="px-2 py-2 font-medium">By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-hairline">
                <td className="px-2 py-2">
                  <button type="button" className="block max-w-full truncate text-left font-medium hover:underline" onClick={row.open}>{row.name}</button>
                  <span className="text-muted-foreground">{row.source}{row.paused && " · Paused"}</span>
                  {row.latestRun && (
                    <div className="mt-0.5 text-muted-foreground">
                      Latest run · {row.latestRun.label}{row.latestRun.at && ` · ${row.latestRun.at}`}
                    </div>
                  )}
                  {row.run && <Button variant="ghost" size="xs" disabled={running !== null} aria-label={`Run ${row.name} now`} onClick={row.run}>Run now</Button>}
                  {row.edit && <Button variant="ghost" size="xs" disabled={opening || running !== null} aria-label={`Edit ${row.name}`} onClick={row.edit}>Edit</Button>}
                  {row.duplicate && <Button variant="ghost" size="xs" disabled={opening || running !== null} aria-label={`Duplicate ${row.name}`} onClick={row.duplicate}>Duplicate</Button>}
                  {row.link && <Button variant="ghost" size="xs" aria-label={`Copy link to ${row.name}`} onClick={row.link}>Copy link</Button>}
                </td>
                <td className="truncate px-2 py-2">{row.trigger}</td>
                <td className="truncate px-2 py-2">{row.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length === 0 && (!displayLocal || !localLoading) && (!displayCloud || loaded)
        && <p className="mt-3 text-sm text-muted-foreground">No automations yet.</p>}
    </div>
  );
}
