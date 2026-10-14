import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, Undo2 } from "lucide-react";
import type { MergedRemovalView } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { MERGED_GRACE_MINUTES, errorMessage, mergedCleanup as native, type HeadBranchSetting, type MergedCleanupSettings as Settings } from "@/lib/api";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { useCloudConnectionsVersion } from "@/lib/cloudConnections";
import {
  bootMergedCleanup,
  branchOutcome,
  cloudMergedTargets,
  dismissMergedNotice,
  mergedCleanupOn,
  mergedRecords,
  LOCAL_HOST,
  restoreMergedRemoval,
  saveMergedCleanupSettings,
  statusKey,
  useMergedCleanup,
  type HostRecords,
} from "@/lib/mergedCleanup";
import { useSessionStore } from "@/lib/sessions";
import { relativeTime } from "@/lib/time";

/** How many removals are listed before "Show all". */
const LISTED = 10;

type Choice = "default" | "on" | "off";

function when(iso: string): string {
  const ago = relativeTime(iso);
  if (ago === "now") return "just now";
  return /^\d+[mhd]$/.test(ago) ? `${ago} ago` : `on ${ago}`;
}

/**
 * GitHub's own "Automatically delete head branches" for a project's
 * repository. It covers the remote branch of a pull request merged while
 * TerminalX is closed, so it is offered here, to a reader who administers
 * the repository. Nothing is shown when GitHub cannot be asked.
 */
function HeadBranchOffer({ projectPath }: { projectPath: string }) {
  const [setting, setSetting] = useState<HeadBranchSetting | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSetting(null);
    native
      .headBranchSetting(projectPath)
      .then((found) => !cancelled && setSetting(found))
      // No `gh`, not signed in, or not on GitHub: there is nothing to offer.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPath]);
  if (!setting) return null;
  if (setting.enabled) return <p className="text-[11px] leading-relaxed text-muted-foreground">GitHub deletes the merged branches of {setting.repository} itself.</p>;
  if (!setting.admin || setting.enabled === null) return null;
  const enable = () => {
    setBusy(true);
    setError(null);
    native
      .enableHeadBranchDeletion(projectPath)
      .then(setSetting)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-relaxed text-muted-foreground">
      <span className="min-w-0 flex-1 basis-[16rem]">
        GitHub can delete the merged branches of {setting.repository} itself. That also covers pull requests merged while TerminalX is not running.
      </span>
      <Button size="xs" variant="outline" disabled={busy} onClick={enable}>
        {busy ? <Loader2 aria-hidden className="animate-spin" /> : null} Turn on “Automatically delete head branches”
      </Button>
      {error ? (
        <span role="alert" className="basis-full text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ProjectChoice({
  settings,
  name,
  where,
  storedAs,
  note,
  problem,
  disabled,
  onChoose,
  children,
}: {
  settings: Settings;
  name: string;
  /** Its path, or what kind of place it is. */
  where: string;
  storedAs: string;
  note?: string | null;
  /** Why nothing in it can go right now. */
  problem?: string | null;
  disabled: boolean;
  onChoose: (key: string, enabled: boolean | null) => void;
  children?: React.ReactNode;
}) {
  const own = settings.projects[storedAs];
  const choice: Choice = own === undefined ? "default" : own ? "on" : "off";
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-[12rem]">
          <div className="truncate text-xs text-foreground">{name}</div>
          <div className="truncate font-mono text-[11px] text-faint">{where}</div>
        </div>
        <Segmented<Choice>
          aria-label={`Delete merged workspaces of ${name}`}
          disabled={disabled}
          value={choice}
          onChange={(next) => onChoose(storedAs, next === "default" ? null : next === "on")}
          options={[
            { value: "default", label: `Default (${settings.enabled ? "on" : "off"})` },
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </div>
      {note ? <p className="text-[11px] leading-relaxed text-muted-foreground">{note}</p> : null}
      {problem ? <p className="text-[11px] leading-relaxed text-warning">{problem}</p> : null}
      {children}
    </li>
  );
}

/** What was removed, newest first, each with Restore while it can still be brought back. */
function RemovedList({ changes }: { changes: number }) {
  const [hosts, setHosts] = useState<HostRecords[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** What a restore said, by record: an error, or what it could not put back. */
  const [said, setSaid] = useState<Record<string, { text: string; failed: boolean }>>({});
  const [all, setAll] = useState(false);
  const load = useCallback(() => mergedRecords().then(setHosts, () => setHosts([])), []);
  useEffect(() => {
    void load();
  }, [load, changes]);

  const rows = useMemo(
    () =>
      (hosts ?? [])
        .flatMap((host) => (host.records ?? []).map((record) => ({ host, record })))
        .sort((a, b) => b.record.removedAt.localeCompare(a.record.removedAt)),
    [hosts],
  );
  const restore = (hostId: string, record: MergedRemovalView) => {
    setBusy(record.id);
    restoreMergedRemoval(hostId, record.id)
      .then((restored) => {
        dismissMergedNotice(record.id);
        setSaid((before) => ({ ...before, [record.id]: { text: restored.notes.join(" "), failed: false } }));
      })
      .catch((e: unknown) => setSaid((before) => ({ ...before, [record.id]: { text: errorMessage(e), failed: true } })))
      .finally(() => {
        setBusy(null);
        void load();
      });
  };

  return (
    <div data-testid="merged-cleanup-records">
      <div className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-faint">Removed automatically</div>
      {hosts === null ? <p className="text-xs text-muted-foreground">Looking…</p> : null}
      {hosts !== null && rows.length === 0 ? <p className="text-xs text-muted-foreground">Nothing has been removed yet.</p> : null}
      {rows.length > 0 ? (
        <ul aria-label="Workspaces removed after their pull request merged" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
          {(all ? rows : rows.slice(0, LISTED)).map(({ host, record }) => {
            const result = said[record.id];
            return (
              <li key={`${host.hostId}\n${record.id}`} className="flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">
                    {record.name}
                    {host.name ? ` · ${host.name}` : ""}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-faint" title={`${record.path}\n${record.commit}`}>
                    {record.branch} at {record.commit.slice(0, 7)}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    <button type="button" className="rounded-sm underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => void openUrl(record.pr.url)}>
                      Pull request #{record.pr.number}
                    </button>{" "}
                    merged; removed {when(record.removedAt)}. {branchOutcome(record)}
                  </span>
                  {record.restoredAt ? (
                    <span className="block text-[11px] text-muted-foreground">Brought back {when(record.restoredAt)}.</span>
                  ) : record.blocked ? (
                    <span className="block text-[11px] text-muted-foreground">Cannot be brought back: {record.blocked}</span>
                  ) : null}
                  {result?.text ? (
                    <span role={result.failed ? "alert" : "status"} className={result.failed ? "block text-[11px] text-destructive" : "block text-[11px] text-foreground"}>
                      {result.text}
                    </span>
                  ) : null}
                </div>
                {!record.restoredAt && !record.blocked ? (
                  <Button size="xs" variant="outline" disabled={busy !== null} aria-label={`Restore ${record.name}`} onClick={() => restore(host.hostId, record)}>
                    {busy === record.id ? <Loader2 aria-hidden className="animate-spin" /> : <Undo2 aria-hidden />} Restore
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!all && rows.length > LISTED ? (
        <Button variant="ghost" size="xs" className="mt-1" onClick={() => setAll(true)}>
          Show all {rows.length}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The setting that removes a workspace by itself once its pull request has
 * merged: the default, each project's own answer, the grace period, whether
 * conversations go too, and what has been removed so far.
 */
export function MergedCleanupSettings() {
  const { settings, ready, notices, unreadable } = useMergedCleanup();
  const store = useSessionStore();
  const catalog = useCloudCatalog();
  const connections = useCloudConnectionsVersion();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bootMergedCleanup();
  }, []);

  const save = (patch: Parameters<typeof saveMergedCleanupSettings>[0]) => {
    setError(null);
    saveMergedCleanupSettings(patch).catch((e: unknown) => setError(errorMessage(e)));
  };
  const choose = (key: string, enabled: boolean | null) => save({ project: { key, enabled } });
  const projects = store.projects.filter((project) => project.kind !== "folder" && !project.archived);
  // The connections are part of what a cloud workspace can be told.
  const cloud = useMemo(() => cloudMergedTargets(catalog), [catalog, connections]);
  const anywhere = settings.enabled || Object.values(settings.projects).some(Boolean);
  // Read the list again when a pass removes something.
  const removals = notices.filter((notice) => notice.kind === "removed").length;
  /** Nothing in a project goes while GitHub cannot be asked about it: say so where it is turned on. */
  const unread = (reason: string | undefined) => (reason ? `Its pull requests could not be read: ${reason}` : null);
  const cloudUnread = (key: string) => Object.entries(unreadable).find(([entry]) => entry.startsWith(`${key}\n`))?.[1];

  return (
    <section data-testid="merged-cleanup-settings" aria-labelledby="merged-cleanup-title" className="flex flex-col">
      <div id="merged-cleanup-title" className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">
        When a pull request is merged
      </div>
      <SettingRow
        label="Delete the workspace when its pull request is merged"
        description="For workspaces TerminalX created. Once a workspace's pull request is merged, its worktree and local branch are deleted, and its branch on the remote too while that still points at the merged commit. Nothing is forced: a workspace with uncommitted or unmerged work, ignored local files, a turn running or a terminal open stays, and its row says why."
        control={<Switch aria-label="Delete the workspace when its pull request is merged" checked={settings.enabled} disabled={!ready} onCheckedChange={(enabled) => save({ enabled })} />}
      />
      <SettingRow
        label="Wait before deleting"
        description="Counted from when the merge is first seen, and from the last thing done in the workspace's sessions if that is later. A notice offers to keep the workspace, and a removal can be undone while its commit is still in the repository."
        disabled={!anywhere}
        stacked
        control={
          <Segmented
            aria-label="Wait before deleting"
            disabled={!ready || !anywhere}
            value={String(settings.graceMinutes)}
            onChange={(minutes) => save({ graceMinutes: Number(minutes) })}
            options={MERGED_GRACE_MINUTES.map((minutes) => ({ value: String(minutes), label: minutes === 60 ? "1 hour" : `${minutes} min` }))}
          />
        }
      />
      <SettingRow
        label="Also delete its conversations"
        description="Off: the conversations of its sessions are kept and filed under the project as from a removed workspace."
        disabled={!anywhere}
        control={<Switch aria-label="Also delete its conversations" checked={settings.deleteConversations} disabled={!ready || !anywhere} onCheckedChange={(deleteConversations) => save({ deleteConversations })} />}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {projects.length + cloud.length > 0 ? (
        <>
          <div className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-faint">Projects</div>
          <ul aria-label="Projects" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
            {projects.map((project) => (
              <ProjectChoice
                key={project.path}
                settings={settings}
                name={project.name}
                where={project.path}
                storedAs={project.path}
                problem={mergedCleanupOn(settings, project.path) ? unread(unreadable[statusKey(LOCAL_HOST, project.path)]) : null}
                disabled={!ready}
                onChoose={choose}
              >
                {mergedCleanupOn(settings, project.path) ? <HeadBranchOffer projectPath={project.path} /> : null}
              </ProjectChoice>
            ))}
            {cloud.map((target) => (
              <ProjectChoice
                key={target.key}
                settings={settings}
                name={target.name}
                where="Cloud workspace"
                storedAs={target.key}
                note={mergedCleanupOn(settings, target.key) ? target.unavailable : null}
                problem={mergedCleanupOn(settings, target.key) && !target.unavailable ? unread(cloudUnread(target.key)) : null}
                disabled={!ready}
                onChoose={choose}
              />
            ))}
          </ul>
        </>
      ) : null}

      <RemovedList changes={removals} />
    </section>
  );
}
