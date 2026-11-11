import { useState } from "react";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MergedCleanupSettings } from "@/components/settings/MergedCleanupSettings";
import { mergedCleanupOn, useMergedCleanup } from "@/lib/mergedCleanup";
import type { usePipelineLaunch } from "@/lib/pipelineLaunch";

/**
 * The pipeline's launch switches. `plain` draws them for a section that is
 * already set apart (the Branch tab's Autopilot): no card of their own, and
 * the explanation cut to a line each.
 */
export function PipelineLaunchControls({ launch, disabled, plain = false }: { launch: ReturnType<typeof usePipelineLaunch>; disabled: boolean; plain?: boolean }) {
  const cleanup = useMergedCleanup();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const keeps = !launch.projectPath || !mergedCleanupOn(cleanup.settings, launch.projectPath);
  const unavailable = launch.unavailable ?? (!launch.settings.enabled ? "The project pipeline is disabled." : undefined);
  return <div role="group" aria-label="Session automation" className={plain ? "flex min-w-0 w-full flex-col gap-2.5 text-xs" : "flex min-w-0 w-full flex-col gap-2 rounded-lg bg-well p-3 text-xs"}>
    <label className="flex items-center justify-between gap-2"><span>Resolve conflicts automatically</span>
      <Switch aria-label="Resolve conflicts automatically" checked={launch.value.resolveConflicts} disabled={disabled || !!unavailable} onCheckedChange={(resolveConflicts) => launch.change({ resolveConflicts })} /></label>
    <label className="flex items-center justify-between gap-2"><span>Merge when green</span>
      <Switch aria-label="Merge when green" checked={launch.value.autoMerge} disabled={disabled || !!unavailable || !!launch.mergeUnavailable || launch.settings.requirePerson} onCheckedChange={(autoMerge) => launch.change({ autoMerge })} /></label>
    {!unavailable && <p className="text-faint">{plain ? "Opens a pull request and reviews it. Without merge, it stops at Ready to merge." : "With automation enabled, TerminalX opens a pull request and reviews it. With merge off, it stops at Ready to merge."}</p>}
    {(unavailable || launch.mergeUnavailable || launch.settings.requirePerson) && <p className="text-faint">{unavailable ?? launch.mergeUnavailable ?? "This project requires a person to merge."}</p>}
    {plain
      ? <p className="text-faint">{keeps ? "Workspace kept after merge" : `Workspace deleted ${cleanup.settings.graceMinutes} min after merge`} · <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setSettingsOpen(true)}>Change</button></p>
      : <p className="text-faint">Delete the workspace after merge: {keeps ? "off; workspace will be kept" : `on, after ${cleanup.settings.graceMinutes} min`}. <button type="button" className="underline" onClick={() => setSettingsOpen(true)}>Change project cleanup settings</button></p>}
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogHeader><DialogTitle>Merged workspace cleanup</DialogTitle></DialogHeader><MergedCleanupSettings /></DialogContent></Dialog>
  </div>;
}
