import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type RebuildableScan } from "@/lib/api";
import { bytesText } from "@/lib/cloudResources";
import { useSessionStore } from "@/lib/sessions";

/** Below this, a workspace's build output is not worth a prompt. */
const WORTH = 100 * 1024 * 1024;
const dismissedKey = (root: string) => `raccoon.freeBuildFiles:${root}`;

/** A list of names as a sentence: "a", "a and b", "a, b and c", and "and N more" past three. */
function names(folders: { path: string }[]): string {
  const shown = folders.slice(0, 3).map((folder) => folder.path);
  const rest = folders.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
}

/**
 * At the top of the Files tab: the build output this workspace could free, and a way to move it to the Trash.
 *
 * Only folders a build or an install makes again are counted (`node_modules`, `dist`, `.next`…, ignored by git, so
 * in no commit); the backend never offers new work or local settings such as `.env` (`src-tauri/src/rebuildable.rs`).
 * Shown only past 100 MB, never while an agent works in the workspace (it could be building), and not again after
 * Not now until the folders have doubled. Asks once more, naming what goes, before moving anything.
 */
export function FreeBuildFiles({ sessionId, root }: { sessionId: string; root: string }) {
  const session = useSessionStore().sessions.find((entry) => entry.id === sessionId);
  const projectPath = session?.projectPath;
  const working = !!session?.tabs.some((tab) => tab.status === "in_progress");
  const [scan, setScan] = useState<RebuildableScan | null>(null);
  const [step, setStep] = useState<"offer" | "confirm" | "moving" | "done">("offer");
  const [freed, setFreed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<number>(() => {
    try { return Number(localStorage.getItem(dismissedKey(root)) ?? 0); } catch { return 0; }
  });

  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    api.workspaceRebuildable(projectPath, root).then((found) => { if (live) setScan(found); }).catch(() => { if (live) setScan(null); });
    return () => { live = false; };
  }, [projectPath, root]);

  if (step === "done") {
    return (
      <div role="status" className="m-3 rounded-lg bg-well px-3 py-2.5 text-xs text-muted-foreground" data-testid="free-build-files">
        Freed {bytesText(freed)}. The folders are in the Trash if you need them back.
      </div>
    );
  }
  if (!projectPath || !scan || scan.bytes < WORTH || (dismissed && scan.bytes < dismissed * 2)) return null;

  const notNow = () => {
    try { localStorage.setItem(dismissedKey(root), String(scan.bytes)); } catch { /* storage unavailable */ }
    setDismissed(scan.bytes);
  };
  const move = () => {
    setStep("moving");
    setError(null);
    api.workspaceFreeRebuildable(projectPath, root, scan.folders.map((folder) => folder.path))
      .then((result) => {
        setFreed(result.bytes);
        setStep("done");
        setScan(null);
      })
      .catch((cause: unknown) => {
        setError(errorMessage(cause));
        setStep("offer");
      });
  };

  return (
    <section aria-label="Free build files" className="m-3 flex flex-col gap-2 rounded-lg bg-well p-3" data-testid="free-build-files">
      {step === "offer" ? (
        <>
          <p className="text-[13px] font-medium text-foreground">{bytesText(scan.bytes)} of build files</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            In {names(scan.folders)}: in no commit, and your next install or build makes them again. Your .env and new files are
            never included.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" disabled={working} onClick={() => setStep("confirm")} title={working ? "An agent is working here; free them once it stops" : undefined}>
              Free {bytesText(scan.bytes)}
            </Button>
            <Button size="sm" variant="ghost" onClick={notNow}>Not now</Button>
            {working && <span className="text-[11px] text-faint">An agent is working here.</span>}
          </div>
        </>
      ) : (
        <>
          <p className="text-[13px] font-medium text-foreground">Move to the Trash?</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {scan.folders.slice(0, 3).map((folder) => `${folder.path} (${bytesText(folder.bytes)})`).join(", ")}
            {scan.folders.length > 3 ? ` and ${scan.folders.length - 3} more` : ""}. Run your install or build again to bring them back.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" disabled={step === "moving"} onClick={move}>{step === "moving" ? "Moving…" : "Move to Trash"}</Button>
            <Button size="sm" variant="ghost" disabled={step === "moving"} onClick={() => setStep("offer")}>Cancel</Button>
          </div>
        </>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
