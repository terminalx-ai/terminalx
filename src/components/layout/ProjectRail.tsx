import { useState } from "react";
import { Archive, BarChart3, CalendarClock, CircleDot, FolderOpen, FolderPlus, ImagePlus, LayoutGrid, Pin, PinOff, RefreshCw, Search, Settings, Sparkles, Trash2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { keycaps } from "@/lib/hotkeys";
import { errorMessage } from "@/lib/api";
import {
  addProject,
  refreshEverything,
  refreshWorkspaces,
  removeProject,
  selectProjectInSidebar,
  setProjectLogo,
  updateProject,
  useSessionStore,
} from "@/lib/sessions";
import { isUnread, sessionColumn } from "@/lib/dashboard";
import type { Project } from "@/types/session";
import { MASCOTS, PROJECT_COLORS, PixelMascot, colorCss } from "./PixelMascot";
import { TITLEBAR_INSET } from "./AppShell";
import { useAutomationStore } from "@/lib/automations";

/**
 * The left rail: one row per attached project, pinned ones first, each with
 * its mascot or logo and how much of its main checkout is uncommitted. The
 * menu on a row is where a project is renamed, dressed and refreshed.
 */
export function ProjectRail({
  onOpenSettings,
  onOpenIssues,
  onOpenAgents,
  onOpenStats,
  onOpenAutomations,
  onOpenSkills,
  onSearch,
}: {
  onOpenSettings: () => void;
  onOpenIssues: () => void;
  onOpenAgents: () => void;
  onOpenStats: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void;
  onSearch: () => void;
}) {
  const store = useSessionStore();
  const automationStore = useAutomationStore();
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [spinning, setSpinning] = useState(false);

  const projects = [...store.projects]
    .filter((p) => !!p.archived === showArchived)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.name.localeCompare(b.name));
  const archivedCount = store.projects.filter((p) => p.archived).length;
  // The two counts beside the dashboard entry, over every project at once.
  const liveSessions = store.sessions.filter((s) => !s.archived);
  const needsYou = liveSessions.filter((s) => sessionColumn(s) === "needs").length;
  const unread = liveSessions.filter(isUnread).length;
  const automationRunning = automationStore.automations.some((automation) => automation.lastOutcome === "pending" || automation.lastOutcome === "running");
  const automationFailures = automationStore.automations.filter((automation) => automation.lastOutcome === "failed").length;

  const pickProject = async () => {
    try {
      const dir = await openDialog({ directory: true, multiple: false, title: "Add a project" });
      if (typeof dir === "string") {
        const p = await addProject(dir);
        selectProjectInSidebar(p.path);
      }
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const refreshAll = async () => {
    setSpinning(true);
    try {
      await refreshEverything();
    } finally {
      setSpinning(false);
    }
  };

  return (
    <div className="flex h-full w-(--rail-w) shrink-0 flex-col border-r border-hairline">
      <div data-tauri-drag-region="deep" className="h-(--titlebar-h) shrink-0" style={{ paddingLeft: TITLEBAR_INSET }} />
      <div className="flex flex-col gap-0.5 px-2">
        <Button variant="ghost" className="justify-start gap-2 px-2" onClick={onSearch}>
          <Search />
          Search
          <Keys chord="mod+k" />
        </Button>
        <Button
          variant="ghost"
          className={cn("justify-start gap-2 px-2", store.view === "issues" && !store.selectedSessionId ? "bg-selected text-foreground" : "")}
          onClick={onOpenIssues}
        >
          <CircleDot />
          Issues
          <Keys chord="mod+i" />
        </Button>
        <WithTooltip label="Agent dashboard" keys={keycaps("mod+shift+a")}>
          <Button
            variant="ghost"
            className={cn("justify-start gap-2 px-2", store.view === "agents" && !store.selectedSessionId ? "bg-selected text-foreground" : "")}
            onClick={onOpenAgents}
          >
            <LayoutGrid />
            <span className="truncate">Agent Dashboard</span>
            <AttentionDots needs={needsYou} unread={unread} />
          </Button>
        </WithTooltip>
        <WithTooltip label="Stats & Usage" keys={keycaps("mod+shift+u")}>
          <Button
            variant="ghost"
            className={cn("justify-start gap-2 px-2", store.view === "stats" && !store.selectedSessionId ? "bg-selected text-foreground" : "")}
            onClick={onOpenStats}
          >
            <BarChart3 />
            <span className="truncate">Stats &amp; Usage</span>
          </Button>
        </WithTooltip>
        <WithTooltip label="Automations" keys={keycaps("mod+shift+r")}>
          <Button
            variant="ghost"
            className={cn("justify-start gap-2 px-2", store.view === "automations" && !store.selectedSessionId ? "bg-selected text-foreground" : "")}
            onClick={onOpenAutomations}
          >
            <CalendarClock />
            <span className="truncate">Automations</span>
            {(automationRunning || automationFailures > 0) && (
              <span className="ml-auto flex items-center gap-1.5 text-[10px] tabular-nums">
                {automationRunning && <span className="size-1.5 rounded-full bg-info animate-pulse-soft" title="Automation running" />}
                {automationFailures > 0 && <span className="text-warning">{automationFailures}</span>}
              </span>
            )}
          </Button>
        </WithTooltip>
        <WithTooltip label="Skills" keys={keycaps("mod+shift+k")}>
          <Button
            variant="ghost"
            className={cn("justify-start gap-2 px-2", store.view === "skills" && !store.selectedSessionId ? "bg-selected text-foreground" : "")}
            onClick={onOpenSkills}
          >
            <Sparkles />
            Skills
            <Keys chord="mod+shift+k" />
          </Button>
        </WithTooltip>
      </div>

      <div className="mt-3 flex items-center justify-between pl-4 pr-2">
        <button
          type="button"
          onClick={() => setShowArchived((v) => !v)}
          className="text-[11px] font-medium uppercase tracking-wide text-faint hover:text-muted-foreground"
          title={archivedCount ? `${archivedCount} archived` : undefined}
        >
          {showArchived ? "Archived" : "Projects"}
        </button>
        <div className="flex items-center">
          <WithTooltip label="Refresh every project">
            <Button variant="ghost" size="icon-xs" aria-label="Refresh all" onClick={() => void refreshAll()}>
              <RefreshCw className={cn(spinning && "animate-spin")} />
            </Button>
          </WithTooltip>
          <WithTooltip label="Add project">
            <Button variant="ghost" size="icon-xs" aria-label="Add project" onClick={() => void pickProject()}>
              <FolderPlus />
            </Button>
          </WithTooltip>
        </div>
      </div>
      {error && <div className="mx-2 mt-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}

      <div className="mt-1 flex-1 overflow-y-auto scrollbar-thin px-2">
        {projects.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-muted-foreground">
            {showArchived ? "Nothing archived." : "Add a project to start."}
          </div>
        )}
        {projects.map((p) => (
          <ProjectRow key={p.path} project={p} selected={store.selectedProject === p.path} />
        ))}
      </div>

      <div className="border-t border-hairline p-2">
        <Button variant="ghost" className="w-full justify-start gap-2 px-2" onClick={onOpenSettings}>
          <Settings />
          Settings
          <Keys chord="mod+," />
        </Button>
      </div>
    </div>
  );
}

/**
 * Two counts on the dashboard entry: amber for sessions waiting on an answer,
 * green for ones that finished and have not been looked at. A count of zero
 * draws nothing, so a quiet rail stays quiet.
 */
function AttentionDots({ needs, unread }: { needs: number; unread: number }) {
  if (!needs && !unread) return null;
  return (
    <span className="ml-auto flex items-center gap-1.5 text-[10px] tabular-nums">
      {needs > 0 && (
        <span className="flex items-center gap-1 text-warning" title={`${needs} waiting on you`}>
          <span className="size-1.5 rounded-full bg-warning" />
          {needs}
        </span>
      )}
      {unread > 0 && (
        <span className="flex items-center gap-1 text-add" title={`${unread} finished and unread`}>
          <span className="size-1.5 rounded-full bg-add" />
          {unread}
        </span>
      )}
    </span>
  );
}

function Keys({ chord }: { chord: string }) {
  return (
    <span className="ml-auto flex gap-0.5 text-[10px] text-faint">
      {keycaps(chord).map((k) => (
        <kbd key={k} className="rounded-sm bg-veil-raised px-1 font-sans">
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function ProjectGlyph({ project, size = 16 }: { project: Project; size?: number }) {
  if (project.logo) {
    return <img src={convertFileSrc(project.logo)} alt="" width={size} height={size} className="shrink-0 rounded-sm object-cover" style={{ width: size, height: size }} />;
  }
  if (project.mascot) return <PixelMascot id={project.mascot} color={project.color} size={size} />;
  return <FolderOpen className="shrink-0" style={{ width: size, height: size, color: colorCss(project.color) }} />;
}

function ProjectRow({ project, selected }: { project: Project; selected: boolean }) {
  const store = useSessionStore();
  const main = store.workspaces[project.path]?.find((w) => w.isMain);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);

  const commitName = () => {
    const n = name.trim();
    if (n && n !== project.name) void updateProject(project.path, { name: n });
  };
  const pickLogo = async () => {
    const file = await openDialog({ multiple: false, title: "Project logo", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }] });
    if (typeof file === "string") await setProjectLogo(project.path, file);
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await refreshWorkspaces(project.path);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu onOpenChange={(o) => o && setName(project.name)}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => selectProjectInSidebar(project.path)}
        onKeyDown={(e) => e.key === "Enter" && selectProjectInSidebar(project.path)}
        className={cn(
          "group relative flex h-8 cursor-default items-center gap-2 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          selected ? "bg-selected" : "hover:bg-selected/50",
        )}
        title={project.path}
      >
        <ProjectGlyph project={project} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
        {project.pinned && <Pin className="size-3 shrink-0 text-faint" />}
        {main && (main.additions > 0 || main.deletions > 0) && (
          <span className="shrink-0 text-[11px] tabular-nums group-hover:hidden group-has-[[data-state=open]]:hidden">
            {main.additions > 0 && <span className="text-add">+{main.additions}</span>}
            {main.deletions > 0 && <span className="ml-1 text-destructive">−{main.deletions}</span>}
          </span>
        )}
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Project menu"
            className="absolute right-1 top-1/2 hidden -translate-y-1/2 group-hover:inline-flex data-[state=open]:inline-flex"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-[13px] leading-none">…</span>
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" className="w-[19rem] p-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitName();
            }
            e.stopPropagation();
          }}
          className="mb-2 h-8 w-full rounded-md bg-well px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/40"
          aria-label="Project name"
        />
        <button
          type="button"
          onClick={() => void pickLogo()}
          className="mb-2 flex w-full items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-veil-raised"
        >
          <span className="flex size-9 items-center justify-center rounded-md bg-well">
            {project.logo ? <ProjectGlyph project={project} size={20} /> : <ImagePlus className="size-4 text-muted-foreground" />}
          </span>
          <span className="min-w-0">
            <span className="block text-[13px]">Project logo</span>
            <span className="block text-[11px] text-faint">{project.logo ? "Click to replace" : "Optional, replaces the mascot"}</span>
          </span>
          {project.logo && (
            <span
              role="button"
              className="ml-auto text-[11px] text-faint hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                void setProjectLogo(project.path, null);
              }}
            >
              Remove
            </span>
          )}
        </button>
        <div className="mb-2 flex items-center gap-1.5 px-1" role="radiogroup" aria-label="Colour">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={(project.color ?? "slate") === c.id}
              onClick={() => void updateProject(project.path, { color: c.id })}
              className={cn("size-5 rounded-full ring-offset-2 ring-offset-popover", (project.color ?? "slate") === c.id && "ring-2 ring-foreground/60")}
              style={{ background: c.css }}
              title={c.id}
            />
          ))}
        </div>
        <div className="px-1 text-[11px] text-faint">Mascot</div>
        <div className="mb-1 flex flex-wrap gap-1 px-1" role="radiogroup" aria-label="Mascot">
          <button
            type="button"
            role="radio"
            aria-checked={!project.mascot}
            onClick={() => void updateProject(project.path, { mascot: null })}
            className={cn("flex size-7 items-center justify-center rounded-md hover:bg-veil-raised", !project.mascot && "bg-veil-strong")}
            title="Folder"
          >
            <FolderOpen className="size-4" style={{ color: colorCss(project.color) }} />
          </button>
          {MASCOTS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={project.mascot === m}
              onClick={() => void updateProject(project.path, { mascot: m })}
              className={cn("flex size-7 items-center justify-center rounded-md hover:bg-veil-raised", project.mascot === m && "bg-veil-strong")}
              title={m}
            >
              <PixelMascot id={m} color={project.color} size={16} />
            </button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void updateProject(project.path, { pinned: !project.pinned })}>
          {project.pinned ? <PinOff /> : <Pin />} {project.pinned ? "Unpin project" : "Pin project"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void revealItemInDir(project.path)}>
          <FolderOpen /> Reveal in Finder
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void refresh()} disabled={busy}>
          <RefreshCw className={cn(busy && "animate-spin")} /> Refresh workspaces
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void updateProject(project.path, { archived: !project.archived })}>
          <Archive /> {project.archived ? "Unarchive" : "Archive"}
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={() => void removeProject(project.path)}>
          <Trash2 /> Remove from TerminalX Next
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
