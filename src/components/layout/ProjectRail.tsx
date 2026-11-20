import { PrivacyImage } from "@/components/ui/privacy-image";
import { SessionRowData } from "./SessionRowExtras";
import { useMemo, useState, type ReactNode } from "react";
import { Bot as BotIcon, CalendarClock, CircleDot, Folder, FolderOpen, Home, ImagePlus, Search, SquarePen } from "@/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { usePrefs } from "@/lib/prefs";
import { githubAvatarUrl, useGithubIdentity } from "@/lib/githubIdentity";
import { ariaKeyShortcut, useKeymap, type ShortcutId } from "@/lib/shortcuts";
import { runShortcut, useShortcutKeycaps } from "@/lib/hotkeys";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { Kbd } from "@/components/ui/tooltip";
import { setProjectLogo, updateProject, useSessionStore } from "@/lib/sessions";
import { useSessionRowFacts } from "@/lib/sessionRowStatus";
import { bucketSessions, COLUMNS, type ColumnId } from "@/lib/dashboard";
import { useCloudDashboard } from "@/lib/cloudDashboard";
import type { Project } from "@/types/session";
import { MASCOTS, PROJECT_COLORS, PixelMascot, colorCss } from "./PixelMascot";
import { useAutomationStore } from "@/lib/automations";
import { useOrganizationVisibility } from "@/lib/organizationVisibility";
import { visibleDashboardSessions } from "@/lib/organizationSessions";
import type { SettingsTab } from "@/components/settings/SettingsPage";
import { SessionSidebar } from "./SessionSidebar";
import { ChatListSidebar } from "./ChatListSidebar";

export interface RailProps {
  /** Hide the sidebar; its button leads the titlebar, so the window's own controls, then it, then the sidebar's. */
  onHide: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onNewSession: () => void;
  onOpenIssues: () => void;
  onOpenAgents: () => void;
  onOpenAutomations: () => void;
  onOpenSkills: () => void;
  onSearch: () => void;
}

/**
 * The sidebar in the shape the reader chose: grouped by project, or (by status, or sections and one list) with the
 * same compact rows (02.13).
 */
export function ProjectRail(props: RailProps) {
  const { sidebarLayout } = usePrefs();
  return <SessionRowData>{sidebarLayout !== "simple" ? <ChatListSidebar {...props} /> : <SessionSidebar {...props} />}</SessionRowData>;
}

/**
 * The destinations at the top of the sidebar (02.01): Home, Overview, New session and Search with their shortcuts, then
 * Automations and Issues, with status beside their names.
 */
export function AppDestinations({
  onOpenHome,
  onNewSession,
  onSearch,
  onOpenIssues,
  onOpenAgents,
  onOpenAutomations,
}: Pick<RailProps, "onOpenHome" | "onNewSession" | "onSearch" | "onOpenIssues" | "onOpenAgents" | "onOpenAutomations">) {
  const store = useSessionStore();
  const automationStore = useAutomationStore();
  // The overview's totals count cloud sessions too (PRO-23 CS-19), like the overview itself.
  const cloudSessions = useCloudDashboard();
  const cloud = useOrganizationVisibility();
  const localFacts = useSessionRowFacts(store.sessions);
  const dashboardBuckets = useMemo(() => bucketSessions([
    ...store.sessions.map((session) => ({ ...session, rowStatus: localFacts[session.id] ?? session.rowStatus })),
    ...visibleDashboardSessions(cloudSessions, cloud.visibleIds),
  ]), [store.sessions, localFacts, cloudSessions, cloud.visibleIds]);
  const automationRunning = automationStore.automations.some((automation) => automation.lastOutcome === "pending" || automation.lastOutcome === "running");
  const automationFailures = automationStore.automations.filter((automation) => automation.lastOutcome === "failed").length;
  // A destination looks active only while it is what the main slot shows: no session and no cloud workspace selected.
  const onNavView = !store.selectedSessionId && !store.selectedCloudWorkspace;
  const active = onNavView ? store.view : null;
  const home = { id: "home", label: "Home", shortcut: "app.home", kbd: true, icon: <Home />, onOpen: onOpenHome } satisfies Destination;
  const overview = { id: "agents", label: "Overview", shortcut: "app.agentDashboard", kbd: true, icon: <Home />, onOpen: onOpenAgents, ...dashboardStatus(dashboardBuckets) } satisfies Destination;
  const newSession = { id: "new", label: "New session", shortcut: "app.newSession", kbd: true, icon: <SquarePen />, onOpen: onNewSession } satisfies Destination;
  const search = { id: "search", label: "Search", shortcut: "app.commandPalette", kbd: true, icon: <Search />, onOpen: onSearch } satisfies Destination;
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
  // Bots (PRO-467) only while Settings → Experimental → Bots is on; it opens as its shortcut does.
  const botsOn = useExperimentalSettings()?.bots === true;
  const bots = { id: "bots", label: "Bots", shortcut: "app.bots", icon: <BotIcon />, onOpen: () => runShortcut("app.bots") } satisfies Destination;
  // Skills and Usage are reached from Settings (and their shortcuts), not from here.
  return <DestinationList active={active} destinations={[home, overview, newSession, search, ...(botsOn ? [bots] : []), automations, issues]} />;
}

/**
 * `status` is read out with the label; `dot` marks it when something there wants a look; `count` is shown beside it
 * in a list; `kbd` shows its shortcut's keys at the row's end.
 */
type Destination = { id: string; label: string; shortcut: ShortcutId; kbd?: boolean; icon: ReactNode; onOpen: () => void; status?: string; dot?: Dot; count?: number };

/** The destinations as named rows, inset and rounded, each with its count or dot, then its shortcut, on the right. */
function DestinationList({ active, destinations }: { active: string | null; destinations: Destination[] }) {
  const keycaps = useShortcutKeycaps();
  const keymap = useKeymap();
  return (
    <div className="flex flex-col gap-0.5" role="toolbar" aria-orientation="vertical" aria-label="Destinations" data-testid="destination-list">
      {destinations.map((destination) => {
        const status = destination.status ?? destination.dot?.label;
        const pressed = active === destination.id;
        const keys = destination.kbd ? keycaps(destination.shortcut) : [];
        return (
          <Button
            key={destination.id}
            variant="ghost"
            className={cn("h-8 justify-start gap-2.5 rounded-md px-2.5 text-[13px] font-normal", pressed ? "bg-selected text-foreground" : "text-muted-foreground")}
            aria-label={status ? `${destination.label}, ${status}` : destination.label}
            aria-keyshortcuts={keymap[destination.shortcut].map((binding) => ariaKeyShortcut(binding)).filter(Boolean).join(" ") || undefined}
            aria-pressed={pressed}
            title={status}
            onClick={destination.onOpen}
          >
            {destination.icon}
            {destination.label}
            <span className="ml-auto flex items-center gap-2">
              {destination.count ? (
                <span
                  aria-hidden
                  className={cn(
                    "min-w-4 rounded-full px-1.5 text-center text-[11px] font-medium tabular-nums",
                    destination.dot?.tone === "warning" ? "bg-warning/15 text-warning" : "bg-info/15 text-info",
                  )}
                >
                  {destination.count}
                </span>
              ) : destination.dot ? (
                <span aria-hidden className={cn("size-1.5 rounded-full", destination.dot.tone === "warning" ? "bg-warning" : "bg-info animate-pulse-soft")} />
              ) : null}
              {keys.length > 0 && <Kbd className="text-faint">{keys.join("")}</Kbd>}
            </span>
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
    return <PrivacyImage src={convertFileSrc(project.logo)} alt="" width={size} height={size} className="shrink-0 rounded-sm object-cover" style={{ width: size, height: size }} />;
  }
  if (project.mascot) return <PixelMascot id={project.mascot} color={project.color} size={size} />;
  const owner = identity?.repo?.split("/")[0];
  if (owner && unavailable !== owner) {
    return (
      <PrivacyImage
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
