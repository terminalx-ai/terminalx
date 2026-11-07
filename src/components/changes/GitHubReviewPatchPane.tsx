import type { ReactNode } from "react";
import { githubReviewAnchor, type ReviewFile, type ReviewThread, type ReviewThreads } from "@/lib/reviewThreads";
import { reviewPatch, splitReviewRows, type ReviewPatchRow } from "@/lib/reviewPatch";

export interface GitHubReviewDiff {
  file: ReviewFile;
  snapshot: ReviewThreads;
  renderThread(thread: ReviewThread): ReactNode;
}

/** PR hunks come from GitHub, not an uncommitted or differently based local tree. */
export function GitHubReviewPatchPane({ review, mode }: { review: GitHubReviewDiff; mode: "split" | "unified" }) {
  const { file, snapshot, renderThread } = review;
  const { rows, complete } = reviewPatch(file.patch ?? "");
  const positions = new Set<string>();
  let beforeLines = 0, afterLines = 0;
  for (const row of rows) {
    if (row.oldNo != null) { positions.add(`LEFT:${row.oldNo}`); beforeLines = Math.max(beforeLines, row.oldNo); }
    if (row.newNo != null) { positions.add(`RIGHT:${row.newNo}`); afterLines = Math.max(afterLines, row.newNo); }
  }
  const placed = new Map<string, ReviewThread[]>();
  const unplaced: ReviewThread[] = [];
  for (const thread of snapshot.threads.filter((thread) => thread.path === file.path || thread.path === file.oldPath)) {
    const anchor = complete ? githubReviewAnchor(thread, snapshot, { ...file, beforeLines, afterLines }) : null;
    const key = anchor && `${anchor.side}:${anchor.end}`;
    if (key && positions.has(key)) placed.set(key, [...(placed.get(key) ?? []), thread]);
    else unplaced.push(thread);
  }
  const threads = (side: "LEFT" | "RIGHT", line: number | undefined) => placed.get(`${side}:${line}`)?.map((thread) => <div key={thread.id} className="p-2 text-xs font-sans" data-review-line={line} data-review-side={side}>{renderThread(thread)}</div>);
  const code = (row: ReviewPatchRow | undefined, side: "LEFT" | "RIGHT") => row && <div className={`flex font-mono text-[11px] ${row.kind === "add" ? "bg-add/10" : row.kind === "del" ? "bg-destructive/10" : ""}`}>
    <span className="w-10 shrink-0 select-none px-1 text-right text-faint">{side === "LEFT" ? row.oldNo : row.newNo}</span>
    <pre className="min-w-0 flex-1 overflow-x-auto px-2">{row.kind === "del" ? "−" : row.kind === "add" ? "+" : " "}{row.text || " "}</pre>
  </div>;
  return <div className="diff-pane min-w-0 overflow-auto scrollbar-thin select-text" aria-label="PR file diff">
    {file.patch == null && <p className="p-2 text-xs text-muted-foreground">{file.changed === false ? "This file is no longer changed in the PR." : "GitHub has no text diff for this file at the current PR head."}</p>}
    {file.patch != null && !complete && <p role="alert" className="p-2 text-xs text-muted-foreground">GitHub returned an incomplete diff. Threads are shown below without line placement.</p>}
    {mode === "split" ? <table className="w-full table-fixed border-collapse" aria-label="Split PR diff">
      <thead><tr className="text-xs text-muted-foreground"><th>Base</th><th>Head</th></tr></thead>
      <tbody>{splitReviewRows(rows).map((pair, index) => pair.hunk ? <tr key={index}><td colSpan={2} className="break-all bg-well px-2 py-1 font-mono text-[11px] text-faint">{pair.hunk}</td></tr> : <tr key={index}>
        <td className="align-top border-r border-hairline">{code(pair.left, "LEFT")}{threads("LEFT", pair.left?.oldNo)}</td>
        <td className="align-top">{code(pair.right, "RIGHT")}{threads("RIGHT", pair.right?.newNo)}</td>
      </tr>)}</tbody>
    </table> : <div aria-label="Unified PR diff">{rows.map((row, index) => <div key={index}>
      {row.kind === "hunk" ? <div className="break-all bg-well px-2 py-1 font-mono text-[11px] text-faint">{row.text}</div> : <>
        {code(row, row.kind === "del" ? "LEFT" : "RIGHT")}
        {threads("LEFT", row.oldNo)}{threads("RIGHT", row.newNo)}
      </>}
    </div>)}</div>}
    {unplaced.length > 0 && <section aria-label="Threads without a current diff line" className="space-y-2 border-t border-hairline p-2">
      <p className="text-xs text-muted-foreground">Outdated threads and threads without a current diff line</p>
      {unplaced.map((thread) => <div key={thread.id}>{renderThread(thread)}</div>)}
    </section>}
  </div>;
}
