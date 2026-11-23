import { useEffect, useState } from "react";
import { Ellipsis, Folder, Loader2, Plus, Trash2 } from "@/icons";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useRowMenu } from "@/components/ui/useRowMenu";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { MachineProjectNode } from "@/lib/machineCatalog";
import { sessionCountText } from "@/lib/machineProjects";
import type { PairedMachine } from "@/types/machines";
import { AddMachineProjectDialog } from "./AddMachineProjectDialog";
import { pageCard, pageHeading } from "./MachinePageAgents";
import { soft } from "./machineText";

/**
 * Projects on a machine's page (21.10, PRO-351): each project with its folder
 * on the machine and how many sessions it has. With `machine/6` (`manage`),
 * "Add a project" opens the dialog of 21.11, and each project's menu has
 * Remove project. Without it the projects are listed and nothing is offered;
 * the page's version banner says what updating brings.
 *
 * `projects` are the machine's catalog entry (`useMachineProjects`), which
 * follows `machine.changed`, so an added or removed project shows here, in
 * the sidebar and in the new-session form alike. `ready` is false until the
 * machine has answered on this connection.
 */
export function MachinePageProjects({
  machine,
  client,
  connected,
  manage,
  projects,
  ready,
}: {
  machine: PairedMachine;
  client: WorkspaceRpcClient | null;
  connected: boolean;
  manage: boolean;
  projects: MachineProjectNode[];
  ready: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<MachineProjectNode | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = manage && connected && !!client;

  // A lost connection or a missing namespace closes what was open.
  useEffect(() => {
    if (canManage) return;
    setAdding(false);
    setConfirming(null);
  }, [canManage]);

  const remove = async (node: MachineProjectNode) => {
    if (!client) return;
    setRemoving(node.project.projectId);
    setError(null);
    try {
      await client.removeMachineProject(node.project.projectId);
    } catch (e) {
      setError(`Could not remove ${node.project.name}: ${errorMessage(e)}`);
    } finally {
      setRemoving(null);
    }
  };
  const askRemove = (node: MachineProjectNode) => {
    // A project with sessions is confirmed first; one without goes at once. Its folder is never deleted.
    if (node.sessions.length) setConfirming(node);
    else void remove(node);
  };

  let body;
  if (!connected) body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">Its projects show once {machine.name} is connected.</p>;
  else if (!ready) body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">Reading its projects…</p>;
  else if (!projects.length) body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{machine.name} has no projects yet.</p>;
  else
    body = (
      <ul aria-label={`Projects on ${machine.name}`} className="divide-y divide-hairline">
        {projects.map((node) => (
          <ProjectRow key={node.key} node={node} machine={machine} canManage={canManage} removing={removing === node.project.projectId} onRemove={() => askRemove(node)} />
        ))}
      </ul>
    );

  return (
    <section className="grid gap-2.5" data-testid="machine-projects-section" aria-label="Projects">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h3 className={pageHeading}>Projects</h3>
        {canManage && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setAdding(true)}>
            <Plus /> Add a project
          </Button>
        )}
      </div>
      <div className={pageCard}>{body}</div>
      {error && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      )}
      {adding && client && <AddMachineProjectDialog machine={machine} client={client} onClose={() => setAdding(false)} />}
      <RemoveMachineProjectDialog machine={machine} client={client} node={confirming} onClose={() => setConfirming(null)} />
    </section>
  );
}

function ProjectRow({ node, machine, canManage, removing, onRemove }: { node: MachineProjectNode; machine: PairedMachine; canManage: boolean; removing: boolean; onRemove: () => void }) {
  const menu = useRowMenu();
  const { project } = node;
  return (
    <li className="flex min-h-12 items-center gap-3 px-3.5 py-2" data-testid="machine-page-project" data-project={project.projectId} {...(canManage ? menu.surface : {})}>
      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{project.name}</div>
        <div className="truncate font-mono text-[12px] text-faint" title={project.path} data-testid="machine-project-path">
          {project.path}
        </div>
      </div>
      <span className="shrink-0 text-[12px] text-faint" data-testid="machine-project-sessions">
        {sessionCountText(node.sessions.length)}
      </span>
      {canManage &&
        (removing ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" aria-label={`Removing ${project.name}`} />
        ) : (
          <DropdownMenu {...menu.root}>
            <DropdownMenuTrigger asChild {...menu.trigger}>
              <Button variant="ghost" size="icon-xs" className="shrink-0 text-faint" aria-label={`More for ${project.name} on ${machine.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem destructive onSelect={onRemove}>
                <Trash2 /> Remove project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
    </li>
  );
}

/**
 * Remove a project that has sessions, asked first in the style of
 * {@link RemoveMachineDialog} (no screen exists for it). Only the project
 * leaves the machine's list: its folder, worktrees and sessions stay.
 */
function RemoveMachineProjectDialog({ machine, client, node, onClose }: { machine: PairedMachine; client: WorkspaceRpcClient | null; node: MachineProjectNode | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [node]);
  if (!node) return null;
  const { project } = node;
  const count = node.sessions.length;
  const remove = async () => {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      await client.removeMachineProject(project.projectId);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent width="max-w-[440px]" data-testid="remove-machine-project">
        <DialogTitle className="text-sm font-semibold">
          Remove {project.name} from {machine.name}?
        </DialogTitle>
        <DialogDescription className={cn(soft, "grid gap-2")}>
          <span>
            {project.name} leaves {machine.name}’s projects, here and on every computer that operates it. It has {count === 1 ? "1 session" : `${count} sessions`}.
          </span>
          <span>
            Its folder <span className="break-all font-mono text-[12px]">{project.path}</span>, its worktrees and its sessions stay on {machine.name}. Nothing is deleted; add the folder again to bring it back.
          </span>
        </DialogDescription>
        {error && (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 className="animate-spin" /> : null} Remove project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
