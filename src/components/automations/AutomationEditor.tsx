import { useEffect, useMemo, useState } from "react";
import { AgentMark } from "@/components/AgentMark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented, Switch } from "@/components/ui/controls";
import { IssueListItem } from "@/components/issues/IssueListItem";
import { automationsApi, errorMessage, issues as issuesApi, type Issue } from "@/lib/api";
import { createAutomation, updateAutomation } from "@/lib/automations";
import { EFFORT_LABEL, PERMISSION_MODES, useModels } from "@/lib/models";
import { usePrefs } from "@/lib/prefs";
import { useSessionStore } from "@/lib/sessions";
import type { Automation, AutomationInput, AutomationIssueReport, AutomationIssueTrigger, AutomationSchedule, AutomationWorkspace, ScheduleKind, SchedulePreset } from "@/types/automations";

const INPUT = "h-8 w-full rounded-md bg-well px-2.5 text-[13px] outline-none ring-offset-background focus:ring-2 focus:ring-ring/30";
const LABEL = "flex flex-col gap-1.5 text-xs font-medium";

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function splitLabels(value: string): string[] {
  return value.split(",").map((label) => label.trim()).filter(Boolean);
}

export interface AutomationEditorPrefill {
  projectPath: string;
  repo: string;
  query: string;
  label?: string;
}

function defaultIssueTrigger(repo = "", query = "label:raccoon state:open"): AutomationIssueTrigger {
  return {
    provider: "github",
    repo,
    query,
    pollIntervalMinutes: 5,
    maxRunsPerTick: 3,
    runOnExisting: false,
    report: {
      comment: true,
      addLabels: ["raccoon-done"],
      removeLabels: ["raccoon"],
      openPr: false,
      onFailure: { comment: true, addLabels: ["raccoon-failed"] },
    },
  };
}

function initialInput(automation: Automation | null, projectPath: string, harness: string, model: string, mode: string, prefill?: AutomationEditorPrefill): AutomationInput {
  if (automation) {
    return {
      name: automation.name,
      enabled: automation.enabled,
      projectPath: automation.projectPath,
      harness: automation.harness,
      model: automation.model,
      effort: automation.effort ?? null,
      mode: automation.mode,
      prompt: automation.prompt,
      workspace: automation.workspace,
      sessionId: automation.sessionId ?? null,
      reuseSession: automation.reuseSession,
      baseRef: automation.baseRef ?? null,
      schedule: automation.schedule,
      precheck: automation.precheck ?? null,
      missedRunGraceMinutes: automation.missedRunGraceMinutes,
      runTimeoutMinutes: automation.runTimeoutMinutes ?? null,
      issueTrigger: automation.issueTrigger ?? null,
    };
  }
  return {
    name: prefill ? `Automate ${prefill.label ?? "GitHub issues"}` : "",
    enabled: true,
    projectPath: prefill?.projectPath || projectPath,
    harness,
    model,
    effort: null,
    mode,
    prompt: prefill
      ? "Work on GitHub issue #{{number}}: {{title}}\n\n{{body}}\n\nLabels: {{labels}}\nIssue: {{url}}\n\nImplement the requested change and summarise what changed."
      : "",
    workspace: "newWorktree",
    sessionId: null,
    reuseSession: false,
    baseRef: null,
    schedule: {
      kind: "preset",
      preset: "weekdays",
      hour: 9,
      minute: 0,
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      timezone: localTimezone(),
      dtstart: new Date().toISOString(),
    },
    precheck: null,
    missedRunGraceMinutes: 60,
    runTimeoutMinutes: null,
    issueTrigger: prefill ? defaultIssueTrigger(prefill.repo, prefill.query) : null,
  };
}

export function AutomationEditor({
  open,
  automation,
  prefill,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  automation: Automation | null;
  prefill?: AutomationEditorPrefill;
  onOpenChange: (open: boolean) => void;
  onSaved: (automation: Automation) => void;
}) {
  const store = useSessionStore();
  const prefs = usePrefs();
  const firstProject = store.projects.find((project) => project.path === prefs.lastProject) ?? store.projects[0] ?? null;
  const firstHarness = store.harnesses.find((harness) => harness.id === prefs.lastAgent && harness.available) ?? store.harnesses.find((harness) => harness.available) ?? null;
  const allModels = useModels();
  const defaultModel = firstHarness
    ? (prefs.lastModel[firstHarness.id] ?? allModels.find((model) => model.harness === firstHarness.id && model.isDefault)?.id ?? "")
    : "";
  const [input, setInput] = useState(() => initialInput(automation, firstProject?.path ?? "", firstHarness?.id ?? "", defaultModel, prefs.lastMode, prefill));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Issue[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setInput(initialInput(automation, firstProject?.path ?? "", firstHarness?.id ?? "", defaultModel, prefs.lastMode, prefill));
      setError(null);
    }
  }, [open, automation, prefill, firstProject?.path, firstHarness?.id, defaultModel, prefs.lastMode]);

  const models = useMemo(() => allModels.filter((model) => model.harness === input.harness), [allModels, input.harness]);
  const sessions = useMemo(
    () => store.sessions.filter((session) => !session.archived && session.projectPath === input.projectPath),
    [store.sessions, input.projectPath],
  );
  const patch = (next: Partial<AutomationInput>) => setInput((current) => ({ ...current, ...next }));
  const patchSchedule = (next: Partial<AutomationSchedule>) => setInput((current) => ({ ...current, schedule: { ...current.schedule, ...next } }));
  const patchIssueTrigger = (next: Partial<AutomationIssueTrigger>) => setInput((current) => ({
    ...current,
    issueTrigger: { ...(current.issueTrigger ?? defaultIssueTrigger()), ...next },
  }));
  const patchIssueReport = (next: Partial<AutomationIssueReport>) => setInput((current) => {
    const issueTrigger = current.issueTrigger ?? defaultIssueTrigger();
    return { ...current, issueTrigger: { ...issueTrigger, report: { ...issueTrigger.report, ...next } } };
  });

  useEffect(() => {
    if (!open || !input.issueTrigger || input.issueTrigger.repo || !input.projectPath) return;
    let live = true;
    issuesApi.githubRepo(input.projectPath)
      .then((repo) => {
        if (live && repo) patchIssueTrigger({ repo });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, input.projectPath, !!input.issueTrigger, input.issueTrigger?.repo]);

  useEffect(() => {
    const trigger = input.issueTrigger;
    if (!open || !trigger || !input.projectPath || !trigger.repo.trim() || !trigger.query.trim()) {
      setPreview([]);
      setPreviewError(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(async () => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const issues = await automationsApi.issuePreview(input.projectPath, trigger.repo, trigger.query);
        if (live) setPreview(issues);
      } catch (cause) {
        if (live) {
          setPreview([]);
          setPreviewError(errorMessage(cause));
        }
      } finally {
        if (live) setPreviewing(false);
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, input.projectPath, input.issueTrigger?.repo, input.issueTrigger?.query]);

  const setTriggerKind = (kind: "schedule" | "issues") => {
    if (kind === "schedule") patch({ issueTrigger: null });
    else patch({ issueTrigger: defaultIssueTrigger(), workspace: "newWorktree", sessionId: null, reuseSession: false, mode: "auto" });
  };

  const setHarness = (harness: string) => {
    const availableModels = allModels.filter((model) => model.harness === harness);
    const model = prefs.lastModel[harness] ?? availableModels.find((value) => value.isDefault)?.id ?? availableModels[0]?.id ?? "";
    patch({ harness, model, effort: availableModels.find((value) => value.id === model)?.defaultEffort ?? null });
  };

  const setScheduleKind = (kind: ScheduleKind) => {
    if (kind === "cron") patchSchedule({ kind, preset: undefined, cron: input.schedule.cron ?? "*/5 * * * *" });
    else patchSchedule({ kind, preset: input.schedule.preset ?? "weekdays", cron: undefined });
  };

  const setPreset = (preset: SchedulePreset) => {
    const weekdays = preset === "weekdays" ? ["MO", "TU", "WE", "TH", "FR"] : preset === "weekly" ? [input.schedule.weekdays[0] ?? "MO"] : [];
    patchSchedule({ preset, weekdays });
  };

  const setWorkspace = (workspace: AutomationWorkspace) => {
    patch({ workspace, sessionId: workspace === "session" ? (sessions[0]?.id ?? null) : null, reuseSession: false });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = automation ? await updateAutomation(automation.id, input) : await createAutomation(input);
      onSaved(saved);
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const canSave = !!input.name.trim()
    && !!input.prompt.trim()
    && !!input.projectPath
    && !!input.harness
    && (input.workspace === "newWorktree" || !!input.sessionId)
    && (!input.issueTrigger || (!!input.issueTrigger.repo.trim() && !!input.issueTrigger.query.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width="max-w-[48rem]" className="max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-thin">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">{automation ? "Edit automation" : "New automation"}</DialogTitle>
          <p className="text-xs text-muted-foreground">Save a prompt and run it manually or on this Mac while the app is open.</p>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <label className={LABEL}>
            Name
            <input autoFocus value={input.name} onChange={(event) => patch({ name: event.target.value })} className={INPUT} placeholder="Weekday build check" />
          </label>
          <label className={LABEL}>
            Project
            <select value={input.projectPath} onChange={(event) => {
              patch({ projectPath: event.target.value, sessionId: null });
              if (input.issueTrigger) patchIssueTrigger({ repo: "" });
            }} className={INPUT}>
              {store.projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}
            </select>
          </label>

          <label className={`${LABEL} col-span-2`}>
            Prompt
            <textarea
              value={input.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
              rows={5}
              className="w-full resize-y rounded-lg bg-well px-3 py-2 text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-ring/30"
              placeholder="Describe the recurring task exactly as you would in a new session."
            />
          </label>

          <label className={LABEL}>
            Agent
            <select value={input.harness} onChange={(event) => setHarness(event.target.value)} className={INPUT}>
              {store.harnesses.map((harness) => <option key={harness.id} value={harness.id} disabled={!harness.available}>{harness.name}{harness.available ? "" : " — unavailable"}</option>)}
            </select>
          </label>
          <label className={LABEL}>
            Model
            <select value={input.model} onChange={(event) => patch({ model: event.target.value, effort: models.find((model) => model.id === event.target.value)?.defaultEffort ?? null })} className={INPUT}>
              {models.length === 0 && <option value="">Agent default</option>}
              {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
          <label className={LABEL}>
            Effort
            <select value={input.effort ?? ""} onChange={(event) => patch({ effort: event.target.value || null })} className={INPUT}>
              <option value="">Default</option>
              {(models.find((model) => model.id === input.model)?.efforts ?? []).map((effort) => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
            </select>
          </label>
          <label className={LABEL}>
            Permissions
            <select value={input.mode} onChange={(event) => patch({ mode: event.target.value })} className={INPUT}>
              {PERMISSION_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>
          </label>

          <div className="col-span-2 border-t border-hairline pt-3">
            <div className="mb-2 text-xs font-medium">Trigger</div>
            <Segmented<"schedule" | "issues">
              aria-label="Automation trigger"
              value={input.issueTrigger ? "issues" : "schedule"}
              onChange={setTriggerKind}
              options={[{ value: "schedule", label: "Schedule" }, { value: "issues", label: "GitHub issues" }]}
            />
          </div>

          {input.issueTrigger ? (
            <>
              <label className={LABEL}>
                Repository
                <input value={input.issueTrigger.repo} onChange={(event) => patchIssueTrigger({ repo: event.target.value })} className={`${INPUT} font-mono`} placeholder="owner/repo" />
              </label>
              <label className={LABEL}>
                Search query
                <input value={input.issueTrigger.query} onChange={(event) => patchIssueTrigger({ query: event.target.value })} className={`${INPUT} font-mono`} placeholder="label:raccoon state:open" />
              </label>
              <label className={LABEL}>
                Check every (minutes)
                <input type="number" min={1} value={input.issueTrigger.pollIntervalMinutes} onChange={(event) => patchIssueTrigger({ pollIntervalMinutes: Math.max(1, Number(event.target.value)) })} className={INPUT} />
              </label>
              <label className={LABEL}>
                New runs per tick
                <input type="number" min={1} max={50} value={input.issueTrigger.maxRunsPerTick} onChange={(event) => patchIssueTrigger({ maxRunsPerTick: Math.max(1, Number(event.target.value)) })} className={INPUT} />
              </label>
              <div className="col-span-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                Issue titles and descriptions can be untrusted. Descriptions are quoted as context, and issue automations start in Auto permissions.
              </div>
              <div className="col-span-2 rounded-lg bg-well p-2">
                <div className="flex items-center justify-between px-1 pb-1.5 text-[11px] text-muted-foreground">
                  <span>{previewing ? "Checking matches…" : `${preview.length} matching issue${preview.length === 1 ? "" : "s"}`}</span>
                  {previewError && <span className="text-destructive">{previewError}</span>}
                </div>
                {preview.length > 0 && (
                  <div className="max-h-40 overflow-y-auto scrollbar-thin">
                    {preview.map((issue) => <IssueListItem key={issue.nodeId ?? issue.id} issue={issue} />)}
                  </div>
                )}
              </div>
              <label className="col-span-2 flex items-center justify-between rounded-lg bg-well px-3 py-2.5 text-xs">
                <span>
                  <span className="block font-medium">Also run on the {preview.length} issues that match now</span>
                  <span className="text-faint">Off by default so enabling a broad query does not launch a backlog.</span>
                </span>
                <Switch checked={input.issueTrigger.runOnExisting} onCheckedChange={(runOnExisting) => patchIssueTrigger({ runOnExisting })} />
              </label>
              <div className="col-span-2 border-t border-hairline pt-3 text-xs font-medium">Report back</div>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={input.issueTrigger.report.comment} onChange={(event) => patchIssueReport({ comment: event.target.checked })} /> Comment with the final response</label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={input.issueTrigger.report.openPr} onChange={(event) => patchIssueReport({ openPr: event.target.checked })} /> Open a PR when commits exist</label>
              <label className={LABEL}>
                Add labels
                <input value={input.issueTrigger.report.addLabels.join(", ")} onChange={(event) => patchIssueReport({ addLabels: splitLabels(event.target.value) })} className={INPUT} placeholder="raccoon-done" />
              </label>
              <label className={LABEL}>
                Remove labels
                <input value={input.issueTrigger.report.removeLabels.join(", ")} onChange={(event) => patchIssueReport({ removeLabels: splitLabels(event.target.value) })} className={INPUT} placeholder="raccoon" />
              </label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={input.issueTrigger.report.onFailure.comment} onChange={(event) => patchIssueReport({ onFailure: { ...input.issueTrigger!.report.onFailure, comment: event.target.checked } })} /> Comment when a run fails</label>
              <label className={LABEL}>
                Failure labels
                <input value={input.issueTrigger.report.onFailure.addLabels.join(", ")} onChange={(event) => patchIssueReport({ onFailure: { ...input.issueTrigger!.report.onFailure, addLabels: splitLabels(event.target.value) } })} className={INPUT} placeholder="raccoon-failed" />
              </label>
            </>
          ) : (
            <>
              <div className="col-span-2">
                <Segmented<ScheduleKind>
                  aria-label="Schedule type"
                  value={input.schedule.kind}
                  onChange={setScheduleKind}
                  options={[{ value: "preset", label: "Preset" }, { value: "cron", label: "Cron" }]}
                />
              </div>
              {input.schedule.kind === "preset" ? (
                <>
                  <label className={LABEL}>
                    Repeats
                    <select value={input.schedule.preset ?? "weekdays"} onChange={(event) => setPreset(event.target.value as SchedulePreset)} className={INPUT}>
                      <option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option>
                    </select>
                  </label>
                  {input.schedule.preset === "weekly" ? (
                    <label className={LABEL}>Day<select value={input.schedule.weekdays[0] ?? "MO"} onChange={(event) => patchSchedule({ weekdays: [event.target.value] })} className={INPUT}>{[['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'], ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  ) : <div />}
                  <label className={LABEL}>
                    {input.schedule.preset === "hourly" ? "Minute" : "Time"}
                    {input.schedule.preset === "hourly" ? <input type="number" min={0} max={59} value={input.schedule.minute ?? 0} onChange={(event) => patchSchedule({ minute: Number(event.target.value) })} className={INPUT} /> : <input type="time" value={`${String(input.schedule.hour ?? 9).padStart(2, "0")}:${String(input.schedule.minute ?? 0).padStart(2, "0")}`} onChange={(event) => { const [hour, minute] = event.target.value.split(":").map(Number); patchSchedule({ hour, minute }); }} className={INPUT} />}
                  </label>
                </>
              ) : <label className={`${LABEL} col-span-2`}>Five-field cron expression<input value={input.schedule.cron ?? ""} onChange={(event) => patchSchedule({ cron: event.target.value })} className={`${INPUT} font-mono`} placeholder="*/5 * * * *" /></label>}
              <label className={LABEL}>Timezone<input value={input.schedule.timezone} onChange={(event) => patchSchedule({ timezone: event.target.value })} className={INPUT} placeholder="America/New_York" /></label>
              <label className={LABEL}>Starts<input type="datetime-local" value={input.schedule.dtstart.slice(0, 16)} onChange={(event) => patchSchedule({ dtstart: new Date(event.target.value).toISOString() })} className={INPUT} /></label>
            </>
          )}

          {input.issueTrigger ? (
            <div className="col-span-2 border-t border-hairline pt-3 text-xs text-muted-foreground">
              Each matching issue gets its own worktree and linked session.
            </div>
          ) : (
            <div className="col-span-2 border-t border-hairline pt-3">
              <div className="mb-2 text-xs font-medium">Workspace</div>
              <Segmented<AutomationWorkspace>
                aria-label="Run workspace"
                value={input.workspace}
                onChange={setWorkspace}
                options={[{ value: "newWorktree", label: "New worktree per run" }, { value: "session", label: "Existing session" }]}
              />
            </div>
          )}
          {!input.issueTrigger && input.workspace === "session" && (
            <label className={`${LABEL} col-span-2`}>
              Session
              <select value={input.sessionId ?? ""} onChange={(event) => patch({ sessionId: event.target.value || null })} className={INPUT}>
                <option value="">Choose a session</option>
                {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
              </select>
            </label>
          )}

          <label className="col-span-2 flex items-center justify-between rounded-lg bg-well px-3 py-2.5 text-xs">
            <span>
              <span className="block font-medium">Enabled</span>
              <span className="text-faint">{input.issueTrigger ? `GitHub is checked every ${input.issueTrigger.pollIntervalMinutes} minute${input.issueTrigger.pollIntervalMinutes === 1 ? "" : "s"}.` : "The scheduler checks this automation every 30 seconds."}</span>
            </span>
            <Switch checked={input.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
          </label>
        </div>

        {input.harness && (
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-faint">
            <AgentMark id={input.harness} className="size-3.5" /> Runs use a real {store.harnesses.find((harness) => harness.id === input.harness)?.name ?? "agent"} session.
          </div>
        )}
        {error && <div className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="accent" disabled={!canSave || saving} onClick={() => void save()}>{saving ? "Saving…" : automation ? "Save changes" : "Create automation"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
