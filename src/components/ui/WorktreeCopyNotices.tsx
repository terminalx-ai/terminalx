import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import type { SessionEntry } from "@/types/session";
import type { WorktreeCopyReport } from "@/types/repositorySettings";

/** The session-start step: 'Copied .env.local and 2 other files'. */
export function copiedStepText(report: Pick<WorktreeCopyReport, "copiedCount" | "firstCopied">): string | null {
  if (report.copiedCount < 1) return null;
  const first = report.firstCopied ?? "a file";
  const others = report.copiedCount - 1;
  return others === 0 ? `Copied ${first}` : `Copied ${first} and ${others} other file${others === 1 ? "" : "s"}`;
}

/** Creation warnings stay visible until dismissed, with bounded path details. */
export function WorktreeCopyNotices() {
  const [notices, setNotices] = useState<{ id: string; name: string; report: WorktreeCopyReport }[]>([]);
  useEffect(() => {
    let live = true;
    const listening = listen<SessionEntry>("session_created", ({ payload }) => {
      const report = payload.worktreeBase?.fileCopy;
      if (live && report && (report.copiedCount > 0 || report.error || report.skipped.length || report.warnings?.length)) {
        setNotices((current) => [...current.filter((item) => item.id !== payload.id), { id: payload.id, name: payload.worktreeName ?? payload.title, report }]);
      }
    });
    void listening.catch(() => {});
    return () => { live = false; void listening.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
  return <>{notices.map(({ id, name, report }) => (
    <div key={id} role="status" className="pointer-events-auto min-h-0 overflow-y-auto rounded-xl bg-popover p-3 text-sm shadow-surface hairline">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium">Workspace file copy · {name}</p>
        <Button size="xs" variant="ghost" aria-label={`Dismiss file copy notice for ${name}`} onClick={() => setNotices((current) => current.filter((notice) => notice.id !== id))}>Dismiss</Button>
      </div>
      {copiedStepText(report) && <p className="mt-1 break-all text-xs text-muted-foreground">{copiedStepText(report)}</p>}
      {report.error && <p className="break-words text-xs text-warning">{report.error}</p>}
      <ul className="mt-2 max-h-48 overflow-y-auto text-xs text-muted-foreground">
        {report.skipped.map(({ path, reason }, index) => <li key={`${index}:${path}`} className="break-all">{path}: {reason}</li>)}
      </ul>
      {report.skippedCount > report.skipped.length && <p className="mt-2 text-xs text-muted-foreground">{report.skippedCount - report.skipped.length} additional files skipped.</p>}
      {!!report.warnings?.length && <ul aria-label="Copied with warnings" className="mt-2 max-h-48 overflow-y-auto text-xs text-warning">
        {report.warnings.map(({ path, reason }, index) => <li key={`${index}:${path}`} className="break-all">{path}: {reason}</li>)}
      </ul>}
    </div>
  ))}</>;
}
