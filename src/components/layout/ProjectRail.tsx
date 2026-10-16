import { useMemo, useState, type ReactNode } from "react";
import { CalendarClock, CircleDot, Folder, FolderOpen, ImagePlus, LayoutGrid } from "@/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { usePrefs } from "@/lib/prefs";
import { githubAvatarUrl, useGithubIdentity } from "@/lib/githubIdentity";
import type { ShortcutId } from "@/lib/shortcuts";
import { setProjectLogo, updateProject, useSessionStore } from "@/lib/sessions";
import { bucketSessions, COLUMNS, type ColumnId } from "@/lib/dashboard";
import { useCloudDashboard } from "@/lib/cloudDashboard";
import type { Project } from "@/types/session";
import { MASCOTS, PROJECT_COLORS, PixelMascot, colorCss } from "./PixelMascot";
import { useAutomationStore } from "@/lib/automations";
import { useCloudSections } from "./cloud/CloudSections";
import { visibleDashboardSessions } from "@/lib/organizationSessions";
import type { SettingsTab } from "@/components/settings/SettingsPage";
import { SessionSidebar } from "./SessionSidebar";
import { ChatListSidebar } from "./ChatListSidebar";

export interface RailProps {
  /** Hide the sidebar; its button leads the titlebar, so the window's own controls, then it, then the sidebar's. */
  onHide: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenAccount: () => void;
  onOpenIssues: () => void;
  onOpenAgents: () => void;
  onOpenStats: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void;
  onSearch: () => void;
}

/** The sidebar in the shape the reader chose: the projects with their conversations, or one flat list of chats. */
export function ProjectRail(props: RailProps) {
  const { sidebarLayout } = usePrefs();
  return sidebarLayout === "list" ? <ChatListSidebar {...props} /> : <SessionSidebar {...props} />;
}

/**
 * Issues, the dashboard, stats, automations and skills, each carrying its own
 * status: a strip of icons, or a labelled list where there is room to name them.
 */
export function AppDestinations({
  onOpenIssues,
  onOpenAgents,
  onOpenAutomations,
}: Pick<RailProps, "onOpenIssues" | "onOpenAgents" | "onOpenAutomations">) {
  const store = useSessionStore();
  const automationStore = useAutomationStore();
  // The dashboard's totals count cloud sessions too (PRO-23 CS-19), like the dashboard itself.
  const cloudSessions = useCloudDashboard();
  const cloud = useCloudSections();
  const dashboardBuckets = useMemo(() => bucketSessions([...store.sessions, ...visibleDashboardSessions(cloudSessions, cloud.visibleIds)]), [store.sessions, cloudSessions, cloud.visibleIds]);
  const automationRunning = automationStore.automations.some((automation) => automation.lastOutcome === "pending" || automation.lastOutcome === "running");
  const automationFailures = automationStore.automations.filter((automation) => automation.lastOutcome === "failed").length;
  // A destination looks active only while it is what the main slot shows: no session and no cloud workspace selected.
  const onNavView = !store.selectedSessionId && !store.selectedCloudWorkspace;
  const active = onNavView ? store.view : null;
  const dashboard = { id: "agents", label: "Agent dashboard", shortcut: "app.agentDashboard", icon: <LayoutGrid />, onOpen: onOpenAgents, ...dashboardStatus(dashboardBuckets) } satisfies Destination;
  const issues = { id: "issues", label: "Issues", shortcut: "app.issues", icon: <CircleDot />, onOpen: onOpenIssues } satisfies Destination;
  const automations: Destination = {
    id: "automations",
    label: "Automations",
    shortcut: "app.automations",
    icon: <CalendarClock />,
    onOpen: onOpenAutomations,
    dot: automationFailures > 0 ? { tone: "warning", label: `${automationFailures} failed` } : automationRunning ? { tone: "info", label: "Running" } : null,
    count: automationFailures || undefined,
  };
  // Skills and Usage are reached from Settings (and their shortcuts), not from here.
  // Named rows, the same in both sidebar layouts: the dashboard leads and says what is waiting on you, or what is still running.
  const waiting = dashboardBuckets.needs.length || dashboardBuckets.working.length;
  return <DestinationList active={active} destinations={[{ ...dashboard, label: "Dashboard", count: waiting || undefined }, issues, automations]} />;
}

/** `status` is read out with the label; `dot` marks it when something there wants a look; `count` is shown beside it in a list. */
type Destination = { id: string; label: string; shortcut: ShortcutId; icon: ReactNode; onOpen: () => void; status?: string; dot?: Dot; count?: number };

/** The destinations as named rows, each with its count or dot on the right. */
function DestinationList({ active, destinations }: { active: string | null; destinations: Destination[] }) {
  return (
    <div className="flex flex-col" role="toolbar" aria-orientation="vertical" aria-label="Destinations" data-testid="destination-list">
      {destinations.map((destination) => {
        const status = destination.status ?? destination.dot?.label;
        const pressed = active === destination.id;
        return (
          <Button
            key={destination.id}
            variant="ghost"
            className={cn("justify-start gap-2 px-2", pressed && "bg-selected text-foreground")}
            aria-label={status ? `${destination.label}, ${status}` : destination.label}
            aria-pressed={pressed}
            title={status}
            onClick={destination.onOpen}
          >
            {destination.icon}
            {destination.label}
            {destination.count ? (
              <span
                aria-hidden
                className={cn(
                  "ml-auto min-w-4 rounded-full px-1.5 text-center text-[10px] font-medium tabular-nums",
                  destination.dot?.tone === "warning" ? "bg-warning/15 text-warning" : "bg-info/15 text-info",
                )}
              >
                {destination.count}
              </span>
            ) : destination.dot ? (
              <span aria-hidden className={cn("ml-auto size-1.5 rounded-full", destination.dot.tone === "warning" ? "bg-warning" : "bg-info animate-pulse-soft")} />
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}

type Dot = { tone: "warning" | "info" | "add"; label: string } | null;

/** The dashboard's totals, read out in full, and one dot: needs you before working. */
function dashboardStatus(buckets: Record<ColumnId, readonly unknown[]>): { status: string; dot: Dot } {
  const status = COLUMNS.map(({ id, label }) => `${buckets[id].length} ${label.toLowerCase()}`).join(", ");
  const dot: Dot = buckets.needs.length ? { tone: "warning", label: status } : buckets.working.length ? { tone: "info", label: status } : null;
  return { status, dot };
}


export function ProjectGlyph({ project, size = 16 }: { project: Project; size?: number }) {
  // A repository with no look of its own wears its GitHub picture: the one of
  // the organisation or user that owns it, as GitHub shows it. A plain folder has none.
  const identity = useGithubIdentity(project.logo || project.mascot || project.kind === "folder" ? null : project.path);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  if (project.logo) {
    return <img src={convertFileSrc(project.logo)} alt="" width={size} height={size} className="shrink-0 rounded-sm object-cover" style={{ width: size, height: size }} />;
  }
  if (project.mascot) return <PixelMascot id={project.mascot} color={project.color} size={size} />;
  const owner = identity?.repo?.split("/")[0];
  if (owner && unavailable !== owner) {
    return (
      <img
        src={githubAvatarUrl(owner, size * 2)}
        alt=""
        title={`On GitHub as ${identity?.repo}`}
        width={size}
        height={size}
        loading="lazy"
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
        onError={() => setUnavailable(owner)}
        data-testid="project-avatar"
      />
    );
  }
  return <Folder className="shrink-0" style={{ width: size, height: size, color: colorCss(project.color) }} />;
}

/**
 * How a project looks and is called: its name, an optional logo, its colour
 * and its mascot. Drawn inside a project's menu; the name is kept on Enter or
 * when the field is left.
 */
export function ProjectAppearance({ project }: { project: Project }) {
  const [name, setName] = useState(project.name);

  const commitName = () => {
    const n = name.trim();
    if (n && n !== project.name) void updateProject(project.path, { name: n });
  };
  const pickLogo = async () => {
    const file = await openDialog({ multiple: false, title: "Project logo", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"] }] });
    if (typeof file === "string") await setProjectLogo(project.path, file);
  };

  return (
    <div className="w-[17rem] p-1" data-testid="project-appearance">
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
    </div>
  );
}
