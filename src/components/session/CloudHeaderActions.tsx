import { useState } from "react";
import { ChevronDown, GitBranch, Play, UserPlus } from "@/icons";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { CloudShareDialog } from "@/components/cloud/CloudShareDialog";
import { showPanelTab } from "@/lib/panelTab";
import type { CloudSessionModel } from "@/lib/cloudSession";

/**
 * A cloud workspace session's header actions where a local session has Run,
 * Git and Share (#1289), in the same places:
 *
 * - Run is shown off, with why: saved actions run on this computer.
 * - Git opens the side panel's Changes tab, where a cloud session commits,
 *   pushes and opens its pull request.
 * - Share opens the workspace's people, as the workspace view's Share does.
 *
 * A paired machine has its own Run menu and branch button (PRO-403) and is
 * not shown these.
 */
export function CloudHeaderActions({ cloud, runMenuReason }: { cloud: CloudSessionModel; runMenuReason: string | null }) {
  const [sharing, setSharing] = useState(false);
  return (
    <>
      {runMenuReason && (
        // A disabled button takes no hover, so its reason is on the wrapper.
        <span className="flex" title={runMenuReason} data-testid="cloud-run-menu-unavailable">
          <Button variant="ghost" size="sm" className="gap-1.5 px-2.5" disabled aria-label={`Run: ${runMenuReason}`}>
            <Play className="size-4" />
            <span className="@max-[560px]/session-header:hidden">Run</span>
            <ChevronDown className="size-3 text-faint" />
          </Button>
        </span>
      )}
      {!cloud.locked && (
        <WithTooltip label="Commit, push and pull requests are in the Changes panel">
          <Button variant="ghost" size="sm" className="gap-1.5 px-2.5" aria-label="Git: open Changes" onClick={() => showPanelTab("changes")} data-testid="cloud-git-button">
            <GitBranch className="size-4" />
            <span className="@max-[560px]/session-header:hidden">Git</span>
          </Button>
        </WithTooltip>
      )}
      {!cloud.locked && (
        <Button
          variant="ghost"
          size="sm"
          // As the local Share: a 20px icon, and a label sized to stand beside it.
          className="gap-1.5 px-3 text-[13px] [&>svg]:size-5"
          aria-label="Share workspace…"
          title={`Who can use the cloud workspace ${cloud.workspaceName}`}
          onClick={() => setSharing(true)}
          data-testid="cloud-share-button"
        >
          <UserPlus />
          <span>Share</span>
        </Button>
      )}
      {sharing && <CloudShareDialog orgId={cloud.orgId} workspaceId={cloud.workspaceId} name={cloud.workspaceName} onClose={() => setSharing(false)} />}
    </>
  );
}
