import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { cloudPipelineSettings, pipelineSettings } from "@/lib/issuePipeline";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import { updateProject } from "@/lib/sessions";
import type { IssuePipelineSettings } from "@/types/issuePipeline";
import type { Project } from "@/types/session";
import type { CloudProject } from "@/types/target";

const ROUNDS = ["1", "2", "3", "4", "5"] as const;

/** One pattern or name per line; commas work too, since a check name has none. */
function lines(text: string, alsoCommas: boolean): string[] {
  return text
    .split(alsoCommas ? /[\n,]/ : /\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * How one project carries a session started from an issue on to a pull
 * request, a review and a merge. Each change is saved as it is made, like
 * the rest of the project menu.
 */
export function IssuePipelineSettingsDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const stored = pipelineSettings(project);
  // What was last asked for, until the project says the same. Two changes
  // made before the first is saved build on each other rather than on what
  // the project still held, so neither undoes the other.
  const intent = useRef<IssuePipelineSettings | null>(null);
  const [draft, setDraft] = useState<IssuePipelineSettings | null>(null);
  const settings = draft ?? stored;
  const [paths, setPaths] = useState(settings.protected.paths.join("\n"));
  const [ignored, setIgnored] = useState(settings.ignoredChecks.join("\n"));
  const [localCommand, setLocalCommand] = useState(settings.localCheckCommand ?? "");
  const [error, setError] = useState<string | null>(null);

  // The text boxes follow the project when the dialog is opened for it, not while someone types.
  useEffect(() => {
    if (!open) return;
    const current = pipelineSettings(project);
    setPaths(current.protected.paths.join("\n"));
    setIgnored(current.ignoredChecks.join("\n"));
    setLocalCommand(current.localCheckCommand ?? "");
    setError(null);
  }, [open, project.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<IssuePipelineSettings>) => {
    const next = { ...(intent.current ?? stored), ...patch };
    intent.current = next;
    setDraft(next);
    setError(null);
    const settled = () => {
      if (intent.current !== next) return;
      intent.current = null;
      setDraft(null);
    };
    void updateProject(project.path, { issuePipeline: next }).then(settled, (cause) => {
      settled();
      setError(errorMessage(cause));
    });
  };
  // The two lists are saved when their box loses focus, and when the dialog
  // closes with the cursor still in one: Escape must not drop what was typed.
  const saveLists = () => {
    const current = intent.current ?? stored;
    const nextPaths = lines(paths, false);
    const nextIgnored = lines(ignored, true);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
    if (same(nextPaths, current.protected.paths) && same(nextIgnored, current.ignoredChecks) && localCommand.trim() === (current.localCheckCommand ?? "")) return;
    save({ protected: { ...current.protected, paths: nextPaths }, ignoredChecks: nextIgnored, ...(localCommand.trim() !== (current.localCheckCommand ?? "") ? { localCheckCommand: localCommand.trim() || null } : {}) });
  };
  const off = !settings.enabled;
  // Not part of the pipeline: what agents may do to this project's issues on their own.
  const [agentUpdates, setAgentUpdates] = useState<boolean | null>(null);
  const agentUpdatesOn = agentUpdates ?? project.agentIssueUpdates === true;
  const saveAgentUpdates = (value: boolean) => {
    setAgentUpdates(value);
    setError(null);
    void updateProject(project.path, { agentIssueUpdates: value }).then(
      () => setAgentUpdates(null),
      (cause) => {
        setAgentUpdates(null);
        setError(errorMessage(cause));
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) saveLists();
        onOpenChange(next);
      }}
    >
      <DialogContent width="max-w-[36rem]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">Issue pipeline · {project.name}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            What happens after a session started from an issue reports its work done: a pull request, a review by a second session, and a merge.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col divide-y divide-hairline">
          <SettingRow
            label="Open a pull request and review it"
            description="Off leaves a session started from an issue as it was: the agent writes code and nothing follows."
            control={<Switch aria-label="Open a pull request and review it" checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />}
          />
          <SettingRow label="Resolve conflicts automatically by default" description="Wait for idle conversations, merge the base, run checks and review the new head."
            control={<Switch aria-label="Resolve conflicts automatically by default" disabled={off} checked={settings.resolveConflicts ?? false} onCheckedChange={(resolveConflicts) => save({ resolveConflicts })} />} />
          <SettingRow label="Conflict resolution limit" description="Stop for a person after this many attempts per pull request."
            control={<Segmented aria-label="Conflict resolution limit" value={String(settings.maxResolutions ?? 3)} options={ROUNDS.map((value) => ({ value, label: value }))} onChange={(value) => save({ maxResolutions: Number(value) })} />} />
          <SettingRow
            disabled={off}
            label="Merge automatically by default"
            description="What “Merge automatically when the review is addressed” starts at for a new issue. Each issue keeps its own switch."
            control={<Switch aria-label="Merge automatically by default" disabled={off || settings.requirePerson} checked={settings.autoMerge} onCheckedChange={(autoMerge) => save({ autoMerge })} />}
          />
          <SettingRow label="Local check command" description="TerminalX runs this command on the final reviewed head, with a 30-minute timeout. Leave empty to use hosted checks."
            control={<input aria-label="Local check command" className="rounded bg-well px-2 py-1 text-xs" value={localCommand} onChange={(event) => setLocalCommand(event.target.value)} onBlur={saveLists} />} />
          <SettingRow label="Use local checks instead of optional hosted checks" description="Required GitHub checks and repository rules still apply. Requires a local check command."
            control={<Switch aria-label="Use local checks instead of optional hosted checks" disabled={!settings.localCheckCommand} checked={settings.localChecksOnly ?? false} onCheckedChange={(localChecksOnly) => save({ localChecksOnly })} />} />
          <SettingRow
            disabled={off}
            label="A person does the merge"
            description="For a repository that deploys from its default branch. Every issue stops at Ready to merge, whatever its switch says."
            control={<Switch aria-label="A person does the merge" disabled={off} checked={settings.requirePerson} onCheckedChange={(requirePerson) => save({ requirePerson })} />}
          />
          <SettingRow
            disabled={off}
            label="Review rounds"
            description="How many reviews a pull request gets before the open findings are left to you."
            control={
              <Segmented
                aria-label="Review rounds"
                disabled={off}
                value={ROUNDS.includes(String(settings.maxRounds) as (typeof ROUNDS)[number]) ? String(settings.maxRounds) : "3"}
                onChange={(rounds) => save({ maxRounds: Number(rounds) })}
                options={ROUNDS.map((value) => ({ value, label: value }))}
              />
            }
          />
          <SettingRow
            disabled={off}
            label="Merge method"
            description="How TerminalX merges. The repository must allow it; branch protection is never bypassed."
            control={
              <Segmented<IssuePipelineSettings["mergeMethod"]>
                aria-label="Merge method"
                disabled={off}
                value={settings.mergeMethod}
                onChange={(mergeMethod) => save({ mergeMethod })}
                options={[
                  { value: "merge", label: "Merge commit" },
                  { value: "squash", label: "Squash" },
                  { value: "rebase", label: "Rebase" },
                ]}
              />
            }
          />

          <div className="py-2">
            <div className="text-[13px] font-medium">Always left for a person</div>
            <p className="text-xs leading-relaxed text-muted-foreground">A pull request that touches any of these is reviewed and checked like the rest, and then waits at Ready to merge.</p>
            <div className="mt-1 flex flex-col">
              {(
                [
                  ["migrations", "Database migrations", "Migration directories, .sql files, schema files."],
                  ["deploy", "Deploy configuration", "CI workflows, Dockerfiles, infrastructure and hosting config."],
                  ["security", "What the security pass flags", "Any finding the reviewer raises in its security pass, whatever its severity."],
                ] as const
              ).map(([key, label, description]) => (
                <SettingRow
                  key={key}
                  disabled={off}
                  label={label}
                  description={description}
                  control={<Switch aria-label={label} size="sm" disabled={off} checked={settings.protected[key]} onCheckedChange={(value) => save({ protected: { ...settings.protected, [key]: value } })} />}
                />
              ))}
            </div>
            <label className="mt-1 flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Paths of your own, one per line, written as in a .gitignore</span>
              <textarea
                aria-label="Protected paths"
                rows={3}
                disabled={off}
                value={paths}
                spellCheck={false}
                placeholder={"saas/src/billing/\n*.plist"}
                onChange={(event) => setPaths(event.target.value)}
                onBlur={saveLists}
                className="resize-y rounded-md bg-well px-2 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 py-2 text-xs">
            <span className="text-[13px] font-medium">Checks that never hold a merge</span>
            <span className="leading-relaxed text-muted-foreground">
              A part of the check’s name, one per line: for a job with no runner, say. Only for checks branch protection does not require; a required check always has to pass.
            </span>
            <textarea
              aria-label="Checks that never hold a merge"
              rows={2}
              disabled={off}
              value={ignored}
              spellCheck={false}
              placeholder="windows-latest"
              onChange={(event) => setIgnored(event.target.value)}
              onBlur={saveLists}
              className="resize-y rounded-md bg-well px-2 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
            />
          </label>
          <SettingRow
            label="Agents comment and change status without asking"
            description="A terminalx issues command can comment on this project's GitHub issues or move their status without asking you each time. Assigning, labels, new issues and Linear issues always ask."
            control={<Switch aria-label="Agents comment and change status without asking" checked={agentUpdatesOn} onCheckedChange={saveAgentUpdates} />}
          />
        </div>

        {error && <div className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A cloud project's issue pipeline (#433). Its workspaces carry an issue
 * session to a pull request and a review, and stop at Ready to merge: a cloud
 * workspace never merges by itself, so there is no switch for that and no
 * category to keep for a person. What is set here is kept on this computer,
 * and taken to the workspace with each issue session started from here.
 */
export function CloudIssuePipelineSettingsDialog({ project, open, onOpenChange }: { project: CloudProject; open: boolean; onOpenChange: (open: boolean) => void }) {
  const prefs = usePrefs();
  const settings = cloudPipelineSettings(project.key, prefs);
  const [ignored, setIgnored] = useState(settings.ignoredChecks.join("\n"));
  const [localCommand, setLocalCommand] = useState(settings.localCheckCommand ?? "");
  useEffect(() => {
    if (open) {
      const current = cloudPipelineSettings(project.key);
      setIgnored(current.ignoredChecks.join("\n"));
      setLocalCommand(current.localCheckCommand ?? "");
    }
  }, [open, project.key]);
  const save = (patch: Partial<IssuePipelineSettings>) => {
    const current = getPrefs().cloudIssuePipelines;
    setPrefs({ cloudIssuePipelines: { ...current, [project.key]: { ...cloudPipelineSettings(project.key), ...patch } } });
  };
  const saveIgnored = () => {
    const next = lines(ignored, true);
    const current = cloudPipelineSettings(project.key).ignoredChecks;
    if (next.length !== current.length || next.some((value, index) => value !== current[index]) || localCommand.trim() !== (settings.localCheckCommand ?? "")) save({ ignoredChecks: next, localCheckCommand: localCommand.trim() || null });
  };
  const off = !settings.enabled;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) saveIgnored();
        onOpenChange(next);
      }}
    >
      <DialogContent width="max-w-[36rem]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">Issue pipeline · {project.fullName}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            A session started from an issue in this project's cloud workspaces is carried on to a pull request and a review by a second session there, and stops at Ready to merge. You merge it from the issue page, with your own GitHub sign-in. These settings are kept on this computer and go to the workspace with each issue session started from here.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-hairline">
          <SettingRow
            label="Open a pull request and review it"
            description="Off leaves a session started from an issue as it was: the agent writes code and nothing follows."
            control={<Switch aria-label="Open a pull request and review it" checked={settings.enabled} onCheckedChange={(enabled) => save({ enabled })} />}
          />
          <SettingRow label="Resolve conflicts automatically by default" description="A resolver waits for idle conversations and reviews each changed head. Cloud merges still require a person."
            control={<Switch aria-label="Resolve conflicts automatically by default" disabled={off} checked={settings.resolveConflicts ?? false} onCheckedChange={(resolveConflicts) => save({ resolveConflicts })} />} />
          <SettingRow label="Conflict resolution limit" description="Stop for a person after this many attempts."
            control={<Segmented aria-label="Conflict resolution limit" value={String(settings.maxResolutions ?? 3)} options={ROUNDS.map((value) => ({ value, label: value }))} onChange={(value) => save({ maxResolutions: Number(value) })} />} />
          <SettingRow label="Local check command" description="The runtime runs this command on the final reviewed head with a 30-minute timeout."
            control={<input aria-label="Local check command" className="rounded bg-well px-2 py-1 text-xs" value={localCommand} onChange={(event) => setLocalCommand(event.target.value)} onBlur={saveIgnored} />} />
          <SettingRow label="Use local checks instead of optional hosted checks" description="Required hosted checks and repository rules still apply."
            control={<Switch aria-label="Use local checks instead of optional hosted checks" disabled={!settings.localCheckCommand} checked={settings.localChecksOnly ?? false} onCheckedChange={(localChecksOnly) => save({ localChecksOnly })} />} />
          <SettingRow
            disabled={off}
            label="Review rounds"
            description="How many reviews a pull request gets before the open findings are left to you."
            control={
              <Segmented
                aria-label="Review rounds"
                disabled={off}
                value={ROUNDS.includes(String(settings.maxRounds) as (typeof ROUNDS)[number]) ? String(settings.maxRounds) : "3"}
                onChange={(rounds) => save({ maxRounds: Number(rounds) })}
                options={ROUNDS.map((value) => ({ value, label: value }))}
              />
            }
          />
          <SettingRow
            disabled={off}
            label="Merge method"
            description="How Merge on the issue page merges. The repository must allow it; branch protection is never bypassed."
            control={
              <Segmented<IssuePipelineSettings["mergeMethod"]>
                aria-label="Merge method"
                disabled={off}
                value={settings.mergeMethod}
                onChange={(mergeMethod) => save({ mergeMethod })}
                options={[
                  { value: "merge", label: "Merge commit" },
                  { value: "squash", label: "Squash" },
                  { value: "rebase", label: "Rebase" },
                ]}
              />
            }
          />
          <label className="flex flex-col gap-1 py-2 text-xs">
            <span className="text-[13px] font-medium">Checks that never hold a merge</span>
            <span className="leading-relaxed text-muted-foreground">
              A part of the check’s name, one per line. Only for checks branch protection does not require; a required check always has to pass.
            </span>
            <textarea
              aria-label="Checks that never hold a merge"
              rows={2}
              disabled={off}
              value={ignored}
              spellCheck={false}
              placeholder="windows-latest"
              onChange={(event) => setIgnored(event.target.value)}
              onBlur={saveIgnored}
              className="resize-y rounded-md bg-well px-2 py-1.5 font-mono text-xs outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
            />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
