import { SettingsDescription } from "./SettingsDescription";
import { bindingText } from "@/lib/shortcuts";
import { SettingsLeaveBoundaryContext, SettingsLeaveGuardContext, useSettingsLeaveBoundary } from "./settingsLeaveGuard";
import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { settingsSectionOffered } from "@/lib/settingsSections";
import { SettingsFileError } from "./SettingsFile";
import { BadgeLegend, CantSaveToast, OpenSettingsFileButton } from "./SettingSources";
import { useSettingsFile } from "@/lib/settingsFile";
import type { SourceBadgeKind } from "@/lib/settingSources";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowLeft, BarChart3, Bot, Wrench, Building2, ChevronDown, ChevronRight, FlaskConical, FolderPlus, Folders, HardDrive, Info, Keyboard, KeyRound, Laptop, Mic, Monitor, Network, Palette, Plug, Plus, Return, Search, Settings, Smartphone, UserRound, X } from "@/icons";
import type { LucideIcon } from "lucide-react";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { OrgMark } from "@/components/layout/OrgMark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { useSessionStore } from "@/lib/sessions";
import { userFileKeys } from "@/lib/settingSources";
import { isRowLink, resolveSetting, sectionShowsUserValues, settingById, SETTINGS_ROWS, SettingControlSlots, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingId, type SettingsSection } from "./settingsRegistry";
import { settingsSectionRenderers } from "./sectionRenderers";
import { SettingsHeaderSlotProvider } from "./settingsHeaderActions";
import { PROJECT_PAGES, projectPageForRow, projectPages, type ProjectPage } from "./RepositoriesTab";
import { ACTIONS_SUBTITLE } from "./RepositoryActionsPage";
import { ORGANIZATION_PAGES, ORGANIZATION_ROLE, organizationPageForRow, organizationPages, roleManagesOrganizationPage, type OrganizationPage } from "./OrganizationSettings";
import { signIn, useAccount } from "@/lib/account";
import { phase2Ready } from "@/lib/phase2Readiness";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { organizationName } from "@/lib/organizationVisibility";
import { openCloudSetup } from "@/lib/cloudSetupFlow";
import { forgetAgentLoginsRequest, onOpenOrganizationSettings, takeOrganizationRequest } from "@/lib/settingsLinks";
import { issues } from "@/lib/api";
import { shortPath } from "@/lib/paths";
import type { OrganizationSummary } from "@/lib/api";
import type { Project } from "@/types/session";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { movePaletteSelection, type PaletteNavigationKey } from "@/lib/commandPalette";
import { groupSettingsByPage, searchSettings, settingsSearchSummary, type SettingSearchMatch } from "@/lib/settingsSearch";

/** Legacy section names and stable row ids are both accepted by every existing entry point. */
export type SettingsTab = SettingsSection | SettingId;
export const DEFAULT_SETTINGS_TAB: SettingsTab = "general";

/** Each section's icon in the menu: a row is an icon and a word, read at a glance. */
const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  account: UserRound,
  devices: Smartphone,
  machines: Laptop,
  stats: BarChart3,
  general: Settings,
  appearance: Palette,
  agents: Bot,
  orchestrator: Network,
  environment: KeyRound,
  localVms: Monitor,
  transcription: Mic,
  integrations: Plug,
  projects: FolderPlus,
  repositories: HardDrive,
  organizations: Building2,
  storage: HardDrive,
  shortcuts: Keyboard,
  experimental: FlaskConical,
  advanced: Wrench,
  about: Info,
};

/** How long a row opened from search or a link stays marked before it fades, and how long the fade takes. */
export const SETTING_HIGHLIGHT_HOLD_MS = 1200;
export const SETTING_HIGHLIGHT_FADE_MS = 700;

/**
 * Pages mounted, hidden, while a search lists their rows, so those rows bring their live control into the result.
 * Only pages whose mount reads local settings and nothing more: a page that scans disk or the network on mount
 * (Storage's leftover scan, Agents' install checks, Account, Machines…) is not started by typing a query. Its
 * results open the page instead. The open page needs no copy: it stays mounted, hidden, and lends its controls.
 */
const LIVE_CONTROL_SECTIONS: ReadonlySet<SettingsSection> = new Set<SettingsSection>(["general", "appearance", "orchestrator", "experimental"]);

/** The row kept at a user-file key, for the Can't save toast to name. */
const userKeySettingTitle = (key: string) => SETTINGS_ROWS.find((row) => row.layout !== "content" && userFileKeys(row.storage.location).includes(key))?.title;

/** The menu's collapsible group a section's pages sit in (PRO-464): its projects, or its organizations. */
const menuGroupOf = (section: SettingsSection): "projects" | "organizations" | null =>
  section === "projects" || section === "repositories" ? "projects" : section === "organizations" ? "organizations" : null;

/** "Owner" beside an organization in the menu (design 11.16). */
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Where a menu row, a search result or a link takes Settings. */
interface Destination {
  /** A project's path, on its pages. */
  path?: string;
  /** A row to mark and bring into view. */
  row?: SettingId;
  page?: ProjectPage;
  /** An organization's id, on its pages. */
  organization?: string;
  organizationPage?: OrganizationPage;
}

// Menu rows (design 09.02): 32px, inset 8px from both edges with rounded corners, text 16px in.
const navClass = (selected: boolean) => cn(
  "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
  selected ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-selected/50 hover:text-foreground",
);
/** What an open row lists beneath it, indented along a hairline (design 11.02, 11.15). */
const NESTED_CLASS = "ml-[15px] grid min-w-0 grid-cols-[minmax(0,1fr)] gap-px border-l border-hairline py-0.5 pl-2";

/** Projects or Organizations in the menu: one row with its count, opening and closing what it lists (design 11.14). */
function MenuGroupRow({ label, icon: Icon, count, open, controls, onToggle }: { label: string; icon: LucideIcon; count: number; open: boolean; controls: string; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return <button type="button" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle} className={navClass(false)}>
    <Icon aria-hidden className="size-4 shrink-0" />
    <span className={cn("truncate", open && "font-medium text-foreground")}>{label}</span>
    <span className="ml-auto shrink-0 text-[12px] tabular-nums text-faint">{count}</span>
    <Chevron aria-hidden className="size-3 shrink-0 text-faint" />
  </button>;
}

/** One of a project's or an organization's pages, under its open row. */
function MenuPageRow({ label, icon: Icon, current, onClick }: { label: string; icon: LucideIcon; current: boolean; onClick: () => void }) {
  return <button type="button" aria-current={current ? "page" : undefined} onClick={onClick}
    className={cn("flex h-7 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
      current ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-selected/50 hover:text-foreground")}>
    <Icon aria-hidden className="size-3.5 shrink-0" />
    <span className="truncate">{label}</span>
  </button>;
}

/** The listbox option id of a search result. */
const resultId = (id: string) => `settings-result-${id}`;

export function SettingsPage({ onBack, initialTab = DEFAULT_SETTINGS_TAB, initialProjectPath, openRequest = 0, onOpenSkills }: {
  onBack: () => void;
  initialTab?: SettingsTab;
  /** The repository instance for a repository-scoped row link. */
  initialProjectPath?: string;
  /** Repeated requests return to the requested row even after navigation within Settings. */
  openRequest?: number;
  onOpenSkills?: () => void;
}) {
  const localBoundary = useSettingsLeaveBoundary();
  const { guards: leaveGuards, warning: leaveWarning, canLeave } = useContext(SettingsLeaveBoundaryContext) ?? localBoundary;
  const close = () => { if (canLeave()) onBack(); };
  const initial = resolveSetting(initialTab);
  const [section, setSection] = useState<SettingsSection>(initial.section);
  const [projectPath, setProjectPath] = useState<string | undefined>(initial.section === "repositories" ? initialProjectPath : undefined);
  const [target, setTarget] = useState<string | null>(() => isRowLink(initialTab) ? initial.id : null);
  // A project page chosen in the sidebar; without one, the page holding the row asked for (PRO-387).
  const [projectPage, setProjectPage] = useState<ProjectPage | null>(null);
  // The organization whose pages are open (PRO-107, PRO-464), and the page chosen in the menu; set by the effect below.
  const [organizationId, setOrganizationId] = useState<string | undefined>(undefined);
  const [organizationPage, setOrganizationPage] = useState<OrganizationPage | null>(null);
  // Projects and Organizations are each one row in the menu, closed when Settings opens unless it opens on one of
  // their pages. Each stays as the person leaves it until Settings closes, which unmounts this page (PRO-464).
  const [projectsOpen, setProjectsOpen] = useState(() => menuGroupOf(initial.section) === "projects");
  const [organizationsOpen, setOrganizationsOpen] = useState(() => menuGroupOf(initial.section) === "organizations");
  const openMenuGroup = useCallback((next: SettingsSection) => {
    const group = menuGroupOf(next);
    if (group === "projects") setProjectsOpen(true);
    if (group === "organizations") setOrganizationsOpen(true);
  }, []);
  const content = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [selectionRequest, setSelectionRequest] = useState(0);
  // A section behind a switch in Settings → Experimental is listed, and found, only while the switch is on.
  const switches = useExperimentalSettings();
  const orchestratorRuns = switches?.orchestratorRuns === true;
  const localVmTasks = switches?.localVmTasks === true;
  // settingsSectionOffered reads the switches as last read; these re-run it when one changes.
  const offered = useCallback((key: string) => settingsSectionOffered(key as Parameters<typeof settingsSectionOffered>[0]), [orchestratorRuns, localVmTasks]);
  // searchSettings reads the Experimental switch itself; the switches re-run it when one changes.
  // Grouped by page, pages in order of their best row; `results` is the rows in that displayed order, which ↑/↓ walk.
  // Every organization the person belongs to has pages, cloud-enabled or not; data privacy mode turns them off.
  const { status: account } = useAccount();
  const privacy = useDataPrivacy().enabled;
  const activeOrganizationId = defaultOrgId(account);
  const memberships: readonly OrganizationSummary[] = !privacy && account.state === "signed-in" ? (account.organizations ?? []) : [];
  const organization = section === "organizations" && organizationId ? memberships.find((candidate) => candidate.id === organizationId) : undefined;
  // An organization's row opens on the organization already open, else the active one (`open` below): a member of it
  // is not offered the rows of pages they do not manage, which their menu leaves out too.
  const searchOrganization = organization ?? memberships.find((candidate) => candidate.id === activeOrganizationId);
  const searchRole = searchOrganization?.role;
  // Billing (PRO-596) is found only where its page exists: the server reports it ready for that organization.
  const searchBilling = !!searchOrganization && phase2Ready(account, searchOrganization.id, "desktopBilling");
  const pages = useMemo(() => groupSettingsByPage(searchSettings(query).filter((match) =>
    (match.id !== "organizations.billing" || searchBilling)
    && (match.row.section !== "organizations" || match.row.scope !== "organization" || !searchRole || roleManagesOrganizationPage(searchRole, organizationPageForRow(match.id))),
  )), [query, orchestratorRuns, localVmTasks, searchRole, searchBilling]);
  const results = useMemo(() => pages.flatMap((page) => page.matches), [pages]);
  const searching = !!query.trim();
  // The live control slot of each result row, by row id (see SettingControlSlots).
  const [slots, setSlots] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map());
  const slotRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const slotRef = (id: string) => {
    let ref = slotRefs.current.get(id);
    if (!ref) {
      ref = (element) => setSlots((current) => {
        if ((current.get(id) ?? null) === element) return current;
        const next = new Map(current);
        if (element) next.set(id, element); else next.delete(id);
        return next;
      });
      slotRefs.current.set(id, ref);
    }
    return ref;
  };
  const highlight = useRef<{ row: HTMLElement; timers: number[] } | null>(null);
  const clearHighlight = useCallback(() => {
    const current = highlight.current;
    if (!current) return;
    current.timers.forEach((timer) => window.clearTimeout(timer));
    delete current.row.dataset.settingHighlight;
    highlight.current = null;
  }, []);
  /** Marks a row opened from search or a link: held briefly, then faded back (instant under reduced motion, by CSS). */
  const highlightRow = useCallback((row: HTMLElement) => {
    clearHighlight();
    row.dataset.settingHighlight = "on";
    const timers = [
      window.setTimeout(() => { row.dataset.settingHighlight = "fading"; }, SETTING_HIGHLIGHT_HOLD_MS),
      window.setTimeout(() => { if (highlight.current?.row === row) { delete row.dataset.settingHighlight; highlight.current = null; } }, SETTING_HIGHLIGHT_HOLD_MS + SETTING_HIGHLIGHT_FADE_MS),
    ];
    highlight.current = { row, timers };
  }, [clearHighlight]);
  useEffect(() => clearHighlight, [clearHighlight]);
  const changeQuery = (value: string) => {
    if (value.trim() && !canLeave()) return;
    // A search hides the open section, and with it any row still marked from the last open.
    if (value.trim()) clearHighlight();
    setQuery(value);
    setSelected(0);
  };
  const { projects } = useSessionStore();
  const repositories = projects.filter((project) => !project.archived);
  // A row of a repository's settings (⌘K, a toast's Open setting, a copied link) names no repository: it opens on the
  // one already open, else the first listed, as the search does. Without a row, none is chosen for the person.
  const project = repositories.find((candidate) => candidate.path === projectPath)
    ?? (section === "repositories" && target ? repositories[0] : undefined);

  const organizationPageShown: OrganizationPage = organization
    ? (() => { const wanted = organizationPage ?? organizationPageForRow(target); return organizationPages(organization, organization.id === activeOrganizationId, phase2Ready(account, organization.id, "desktopBilling")).some((entry) => entry.page === wanted) ? wanted : "general"; })()
    : "general";
  const organizationPageLabel = ORGANIZATION_PAGES.find((entry) => entry.page === organizationPageShown)!.label;
  // A message elsewhere asks for an organization's page (settingsLinks.ts): the one it names, else the active one.
  // A request for one with no page here (not a member, or none active) is dropped with its logins request, as before.
  const accountRef = useRef({ activeOrganizationId, memberships });
  accountRef.current = { activeOrganizationId, memberships };
  const takeRequestedOrganization = useCallback((): { id: string | undefined } | undefined => {
    const wanted = takeOrganizationRequest();
    if (wanted === undefined) return undefined;
    const id = wanted ?? accountRef.current.activeOrganizationId;
    if (!id || !accountRef.current.memberships.some((candidate) => candidate.id === id)) forgetAgentLoginsRequest();
    return { id: id ?? undefined };
  }, []);

  const page: ProjectPage = section === "repositories" && project
    ? (() => { const wanted = projectPage ?? projectPageForRow(target); return projectPages(project).some((entry) => entry.page === wanted) ? wanted : "general"; })()
    : "general";
  const pageLabel = PROJECT_PAGES.find((entry) => entry.page === page)!.label;

  useEffect(() => {
    setSection(initial.section);
    setProjectPath((open) => initial.section === "repositories" ? initialProjectPath ?? open : undefined);
    setTarget(isRowLink(initialTab) ? initial.id : null);
    setProjectPage(null);
    // An organization's row opens on the organization a message asked for, else the one already open; a request
    // taken here is not taken again by the listener below. Anything else in the section opens its list.
    const requested = initial.section === "organizations" ? takeRequestedOrganization() : undefined;
    const organizationRow = isRowLink(initialTab) && initial.scope === "organization";
    setOrganizationId((open) => initial.section !== "organizations" ? undefined : requested ? requested.id : organizationRow ? open : undefined);
    setOrganizationPage(null);
    openMenuGroup(initial.section);
    setQuery("");
    setSelected(0);
    setSelectionRequest((request) => request + 1);
  }, [initial.id, initial.section, initialTab, initialProjectPath, openRequest]);

  // A row of an organization names none: it opens on the active organization, once the account says which it is.
  useEffect(() => {
    if (section !== "organizations" || !activeOrganizationId || !target || settingById(target)?.scope !== "organization") return;
    setOrganizationId((open) => open ?? activeOrganizationId);
  }, [section, target, activeOrganizationId, openRequest]);

  // Rows can appear after account/native settings load. Resolve only inside this
  // page and stop observing on navigation, so a late response cannot steal focus.
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    root.scrollTop = 0;
    if (!target) {
      if (!hasEscapeOverlay(resultsRef.current)) headingRef.current?.focus({ preventScroll: true });
      return;
    }
    let markedRow: HTMLElement | null = null;
    const reveal = () => {
      // Starting a search cancels any deferred row focus while its section loads.
      if (resultsRef.current) return true;
      const row = [...root.querySelectorAll<HTMLElement>("[data-setting-id]")].find((element) => element.dataset.settingId === target);
      if (!row) return false;
      for (let parent: HTMLElement | null = row; parent && parent !== root; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      // Organization sections retain their layout with a display:contents boundary.
      const visible = getComputedStyle(row).display === "contents" ? row.firstElementChild as HTMLElement | null : row;
      if (!visible) return false;
      // Marking the row asks nested tab containers to reveal it. Keep observing
      // until that tab commits its visibility before scrolling or moving focus.
      // Each navigation must signal again, even if a previous request still
      // highlights this row. Retries within this request need no new signal.
      if (markedRow !== visible) {
        highlightRow(visible);
        markedRow = visible;
      }
      if (visible.closest("[hidden]")) return false;
      visible.scrollIntoView?.({ block: "start" });
      // Sign-in links may also open their existing consent dialog. Keep focus there.
      if (!hasEscapeOverlay()) { visible.tabIndex = -1; visible.focus({ preventScroll: true }); }
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [section, projectPath, project?.path, projectPage, organization?.id, organizationPageShown, target, openRequest, selectionRequest, highlightRow]);

  useEffect(() => {
    resultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [selected, query]);


  useHotkey("escape", () => {
    if (hasEscapeOverlay(resultsRef.current)) return false;
    if (query) {
      changeQuery("");
      inputRef.current?.focus();
      return;
    }
    close();
  });
  useHotkey("mod+f", () => {
    if (hasEscapeOverlay(resultsRef.current)) return false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, { global: true });
  // A page chosen in the sidebar opens at its top with no row marked; only search and links name a row (PRO-387).
  const choose = (next: SettingsSection, to: Destination = {}) => {
    if (!canLeave()) return;
    if (!to.row) clearHighlight();
    setSection(next);
    setProjectPath(to.path);
    setProjectPage(to.page ?? null);
    setOrganizationId(to.organization);
    setOrganizationPage(to.organizationPage ?? null);
    setTarget(to.row ?? null);
    openMenuGroup(next);
    changeQuery("");
    setSelectionRequest((request) => request + 1);
  };
  // An organization's page opened by hand: no earlier message's request scrolls it.
  const chooseOrganization = (id: string | null, organizationPage: OrganizationPage = "general") => {
    forgetAgentLoginsRequest();
    choose("organizations", id ? { organization: id, organizationPage } : {});
  };
  // A message elsewhere (settingsLinks.ts) while Settings is open: its organization's page, at the row it names.
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => onOpenOrganizationSettings((row) => {
    if (!canLeave()) return;
    const requested = takeRequestedOrganization();
    if (requested) chooseRef.current("organizations", { organization: requested.id, row });
  }), [canLeave, takeRequestedOrganization]);
  // A repository row opens on the repository already open, else the first one listed; with none added, on the
  // Projects page that says so.
  // An organization's row, likewise, on the organization already open, else the active one.
  const open = (match: SettingSearchMatch) => {
    if (match.section === "organizations") {
      return choose("organizations", { row: match.id, organization: match.row.scope === "organization" ? organization?.id ?? activeOrganizationId ?? undefined : undefined });
    }
    if (match.section !== "repositories") return choose(match.section, { row: match.id });
    const path = project?.path ?? repositories[0]?.path;
    return path ? choose("repositories", { path, row: match.id }) : choose("repositories");
  };
  const createOrganization = () => {
    if (account.state === "signed-in" && account.identity) openCloudSetup({ kind: "create" });
    else void signIn();
  };

  return (
    // The settings menu stands where the project sidebar stands, at its width and in its row style, so opening Settings
    // reads as the sidebar changing what it lists rather than a different screen.
    <SettingsLeaveGuardContext.Provider value={leaveGuards}>
    <main className="flex h-full min-w-0 flex-1 bg-background" aria-label="Settings">
      <aside className="flex h-full min-h-0 w-(--sidebar-w) shrink-0 flex-col border-r border-hairline">
        {/* Design 09.02: "← Back to app" with its esc key, right of the traffic lights. The page is named by <main>. */}
        <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center justify-end pl-[78px] pr-2">
          <h1 className="sr-only">Settings</h1>
          <button type="button" aria-label="Back to app" aria-keyshortcuts="Escape" onClick={close}
            className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-veil-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
            <ArrowLeft aria-hidden className="size-3.5" />
            <span>Back to app</span>
            <kbd aria-hidden className="rounded border border-hairline px-1 font-sans text-[11px] leading-4 text-faint">esc</kbd>
          </button>
        </div>
        {/* Search heads the menu, as it does the things it searches. */}
          <div className="mx-2 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-md bg-well px-2.5 hairline focus-within:ring-1 focus-within:ring-ring/40">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Search settings"
            aria-autocomplete="list"
            aria-expanded={searching}
            aria-controls={searching ? "settings-search-results" : undefined}
            aria-activedescendant={searching && results[selected] ? resultId(results[selected].id) : undefined}
            placeholder="Search settings…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || !searching) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((current) => movePaletteSelection(current, results.length, event.key as PaletteNavigationKey));
              } else if (event.key === "Enter" && results[selected]) {
                event.preventDefault();
                open(results[selected]);
              }
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
          {!query && <kbd className="shrink-0 rounded border border-hairline px-1 font-sans text-[12px] leading-4 text-faint">{bindingText("mod+f")}</kbd>}
          {query && <Button variant="ghost" size="icon-sm" aria-label="Clear settings search" className="-mr-1.5 size-6" onClick={() => { changeQuery(""); inputRef.current?.focus(); }}><X /></Button>}
          </div>
        <nav aria-label="Settings sections" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3 pt-2 scrollbar-thin">
          {SETTINGS_GROUPS.map((group, index) => (
            <div key={group} role="group" aria-labelledby={`settings-group-${index}`}>
              <div id={`settings-group-${index}`} className="flex h-6 items-center px-2 text-[11px] font-medium uppercase tracking-[.08em] text-faint">{group}</div>
              {group === "Projects & organizations" ? <>
                {/* One row each, with its count, closed until opened (design 11.14). Opened, Projects lists Project
                    templates and then each project; a project's row opens its General page and, while open, lists
                    its pages beneath it (design 11.15). */}
                <MenuGroupRow label="Projects" icon={Folders} count={repositories.length} open={projectsOpen} controls="settings-menu-projects" onToggle={() => setProjectsOpen((open) => !open)} />
                {projectsOpen && <div id="settings-menu-projects" role="group" aria-label="Projects" className={NESTED_CLASS}>
                  <button type="button" aria-current={section === "projects" ? "page" : undefined} onClick={() => choose("projects")} className={navClass(section === "projects")}>
                    <FolderPlus aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">{SETTINGS_SECTIONS.projects.title}</span>
                  </button>
                  {repositories.length ? repositories.map((repository) => {
                    const open = section === "repositories" && project?.path === repository.path;
                    const Chevron = open ? ChevronDown : ChevronRight;
                    return (
                      <div key={repository.path}>
                        <button type="button" title={repository.path} aria-expanded={open} className={navClass(false)} onClick={() => choose("repositories", { path: repository.path, page: "general" })}>
                          <ProjectGlyph project={repository} size={16} />
                          <span className={cn("truncate", open && "font-medium text-foreground")}>{repository.name}</span>
                          <Chevron aria-hidden className="ml-auto size-3 shrink-0 text-faint" />
                        </button>
                        {open && <div role="group" aria-label={`${repository.name} settings`} className={NESTED_CLASS}>
                          {projectPages(repository).map((entry) => (
                            <MenuPageRow key={entry.page} label={entry.label} icon={entry.icon} current={entry.page === page} onClick={() => choose("repositories", { path: repository.path, page: entry.page })} />
                          ))}
                        </div>}
                      </div>
                    );
                  }) : <p className="px-2 py-2 text-xs text-faint">No projects added.</p>}
                </div>}
                {/* Organizations work as projects do: each a row with the person's role, expanding to the pages
                    they can manage, and Create organization at the end (design 11.16). */}
                <MenuGroupRow label="Organizations" icon={Building2} count={memberships.length} open={organizationsOpen} controls="settings-menu-organizations" onToggle={() => setOrganizationsOpen((open) => !open)} />
                {organizationsOpen && <div id="settings-menu-organizations" role="group" aria-label="Organizations" className={NESTED_CLASS}>
                  {/* The list of organizations, with which of them the sidebar shows, leads the group as Project
                      templates leads Projects. */}
                  <button type="button" aria-current={section === "organizations" && !organization ? "page" : undefined} onClick={() => chooseOrganization(null)} className={navClass(section === "organizations" && !organization)}>
                    <Building2 aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">All organizations</span>
                  </button>
                  {memberships.map((candidate) => {
                    const open = organization?.id === candidate.id;
                    const name = organizationName(candidate);
                    const Chevron = open ? ChevronDown : ChevronRight;
                    return (
                      <div key={candidate.id}>
                        <button type="button" title={name} aria-expanded={open} className={navClass(false)} onClick={() => chooseOrganization(candidate.id)}>
                          <OrgMark name={name} />
                          <span className={cn("truncate", open && "font-medium text-foreground")}>{name}</span>
                          <span className="shrink-0 text-[12px] text-faint">{ROLE_LABEL[candidate.role] ?? candidate.role}</span>
                          <Chevron aria-hidden className="ml-auto size-3 shrink-0 text-faint" />
                        </button>
                        {open && <div role="group" aria-label={`${name} settings`} className={NESTED_CLASS}>
                          {organizationPages(candidate, candidate.id === activeOrganizationId, phase2Ready(account, candidate.id, "desktopBilling")).map((entry) => (
                            <MenuPageRow key={entry.page} label={entry.label} icon={entry.icon} current={entry.page === organizationPageShown} onClick={() => chooseOrganization(candidate.id, entry.page)} />
                          ))}
                        </div>}
                      </div>
                    );
                  })}
                  {!privacy && <button type="button" onClick={createOrganization} className={navClass(false)}>
                    <Plus aria-hidden className="size-4 shrink-0" />
                    <span className="truncate">Create organization</span>
                  </button>}
                </div>}
              </> : Object.entries(SETTINGS_SECTIONS).filter(([key, entry]) => entry.group === group && offered(key)).map(([key, entry]) => (
                <button key={key} type="button" aria-current={section === key ? "page" : undefined} onClick={() => choose(key as SettingsSection)} className={navClass(section === key)}>
                  {(() => { const Icon = SECTION_ICONS[key as SettingsSection]; return <Icon aria-hidden className="size-4 shrink-0" />; })()}
                  <span className="truncate">{entry.title}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Open settings.json, top right of every page (PRO-140); a project page opens the project's own file (PRO-388). */}
        <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-2 px-3 empty:hidden">
          {/* A project page says where it is: ⚙ › Projects › project › page (design 11.02). */}
          {section === "repositories" && project && !searching && <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 pl-2 text-[12px] text-faint">
            <Settings aria-hidden className="size-3.5 shrink-0" />
            <ChevronRight aria-hidden className="size-3 shrink-0" />
            <span className="whitespace-nowrap">Projects</span>
            <ChevronRight aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{project.name}</span>
            <ChevronRight aria-hidden className="size-3 shrink-0" />
            <span aria-current="page" className="whitespace-nowrap text-muted-foreground">{pageLabel}</span>
          </nav>}
          {/* And an organization's page: ⚙ › Organizations › organization › page (design 11.16). */}
          {organization && !searching && <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 pl-2 text-[12px] text-faint">
            <Settings aria-hidden className="size-3.5 shrink-0" />
            <ChevronRight aria-hidden className="size-3 shrink-0" />
            <span className="whitespace-nowrap">Organizations</span>
            <ChevronRight aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{organizationName(organization)}</span>
            <ChevronRight aria-hidden className="size-3 shrink-0" />
            <span aria-current="page" className="whitespace-nowrap text-muted-foreground">{organizationPageLabel}</span>
          </nav>}
          <div className="ml-auto flex shrink-0 items-center gap-2 empty:hidden"><OpenSettingsFileButton projectPath={section === "repositories" && project && project.kind !== "folder" ? project.path : null} /></div>
        </div>
        <div className="flex min-h-0 flex-1">
        <section ref={content} className={cn(
          "min-w-0 flex-1 overflow-y-auto scrollbar-thin",
          // A row opened from search or a link (data-setting-highlight, set by the reveal above): the selected fill with
          // an accent edge, drawn as spread shadows so the row's layout does not move; it fades back, at once under
          // reduced motion.
          "[&_[data-setting-highlight]]:rounded-md [&_[data-setting-highlight]]:transition-[background-color,box-shadow] [&_[data-setting-highlight]]:duration-700 [&_[data-setting-highlight]]:ease-out motion-reduce:[&_[data-setting-highlight]]:transition-none",
          "[&_[data-setting-highlight=on]]:bg-selected [&_[data-setting-highlight=on]]:shadow-[0_0_0_6px_var(--color-selected),0_0_0_7px_color-mix(in_oklab,var(--color-accent)_40%,transparent)]",
        )} aria-labelledby={searching ? "settings-results-title" : "settings-section-title"}>
          {/* A broken settings file is named by the red Open settings.json and the Can't save toast, not a banner (09.43). */}
          <div className="mx-auto w-full max-w-[48rem] px-6 pt-2 empty:hidden"><SettingsFileError /></div>
          {searching && <div className="mx-auto w-full max-w-[48rem] px-6 pt-2 pb-6">
            {/* Design 09.31: the query as the page title, the count and the keys beneath it, then the rows by page. */}
            <h2 id="settings-results-title" className="break-words text-[22px] font-semibold tracking-tight">Results for “{query.trim()}”</h2>
            {results.length > 0 && <p className="mt-1 text-[13px] text-muted-foreground">{settingsSearchSummary(results)} · ↑↓ to move · ↵ opens the setting · esc clears</p>}
            <div ref={resultsRef} id="settings-search-results" role="listbox" aria-label="Settings search results" className="mt-2">
              {pages.map((page) => {
                const Icon = SECTION_ICONS[page.section];
                return (
                  <div key={page.section} role="group" aria-labelledby={`settings-results-${page.section}`}>
                    <div id={`settings-results-${page.section}`} className="mb-1 mt-4 px-3 text-[12px] uppercase tracking-[.08em] text-faint">{page.title}</div>
                    {page.matches.map((match) => {
                      const index = results.indexOf(match);
                      const current = selected === index;
                      return (
                        // An option, not a button: it holds the row's live control (design 09.01), which takes its own clicks.
                        <div
                          key={match.id}
                          id={resultId(match.id)}
                          role="option"
                          aria-selected={current}
                          onMouseEnter={() => setSelected(index)}
                          onClick={() => open(match)}
                          className={cn(
                            "flex w-full cursor-default items-center gap-5 rounded-lg px-3 py-2.5 text-left outline-none",
                            current ? "bg-selected ring-1 ring-accent/40" : "hover:bg-veil-raised",
                          )}
                        >
                          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex min-w-0 flex-1 flex-col [&_mark]:rounded-[3px] [&_mark]:bg-accent/25 [&_mark]:px-px [&_mark]:[font-weight:inherit]">
                            <span className="text-[13px] font-medium"><HighlightedText text={match.row.title} ranges={match.titleRanges} /></span>
                            {/* One line, as designed; the full text is on the page and in the tooltip. */}
                            <span title={match.row.description} className="truncate text-xs text-muted-foreground"><HighlightedText text={match.row.description} ranges={match.descriptionRanges} /></span>
                          </span>
                          <span ref={slotRef(match.id)} data-result-control="" className="flex shrink-0 items-center empty:hidden" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} />
                          {current && <Return aria-hidden className="size-3.5 shrink-0 text-faint" />}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* A change made from a result that its page refuses shows on its page, which is hidden: say it here. */}
            <SearchPageAlerts root={content} pages={pages} />
            {/* Each other result page, hidden, hands its rows' live controls to the slots above. */}
            <SettingControlSlots.Provider value={slots}>
              <div hidden aria-hidden>
                {pages.filter((page) => page.section !== section && LIVE_CONTROL_SECTIONS.has(page.section) && page.matches.some((match) => slots.has(match.id))).map((page) => (
                  <div key={page.section} data-search-page={page.section}>{settingsSectionRenderers[page.section]({ onOpenSkills })}</div>
                ))}
              </div>
            </SettingControlSlots.Provider>
            {/* Design 09.33. */}
            {!results.length && <div role="status" className="py-6 text-center">
              <p className="text-sm text-muted-foreground">No settings match “{query.trim()}”</p>
              <p className="mt-1 text-[12px] text-faint">Try fewer letters, or <button type="button" className="text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => choose("shortcuts")}>search keyboard shortcuts</button>.</p>
            </div>}
          </div>}
          <div hidden={searching} data-search-page={section} className={cn("mx-auto w-full px-6 pt-2 pb-12", section === "stats" ? "max-w-[58rem]" : "max-w-[48rem]")} key={`${section}:${project?.path ?? ""}:${section === "repositories" ? page : ""}:${organization?.id ?? ""}:${organization ? organizationPageShown : ""}`}>
            <div className={cn("flex flex-wrap items-start justify-between gap-3", (section === "repositories" && project) || organization ? "mb-3" : "mb-5")}>
              {section === "repositories" && project ? <div className="min-w-0 flex-1 basis-48">
                {/* One title a page, the page's name, with the project beneath it (design 11.02, 11.10). */}
                <h2 ref={headingRef} tabIndex={-1} id="settings-section-title" className="break-words text-[22px] font-semibold tracking-tight outline-none">{pageLabel}</h2>
                <ProjectPageSubtitle project={project} page={page} />
              </div> : organization ? <div className="min-w-0 flex-1 basis-48">
                {/* The page's name, with the organization and the person's role in it beneath (design 11.16). */}
                <h2 ref={headingRef} tabIndex={-1} id="settings-section-title" className="break-words text-[22px] font-semibold tracking-tight outline-none">{organizationPageLabel}</h2>
                <p className="mt-1 break-words text-[13px] text-muted-foreground">{organizationName(organization)} · you are {ORGANIZATION_ROLE[organization.role] ?? organization.role}</p>
              </div> : <div className="min-w-0 flex-1 basis-48"><h2 ref={headingRef} tabIndex={-1} id="settings-section-title" aria-describedby="settings-section-subtitle" className="break-words text-[22px] font-semibold leading-7 tracking-tight outline-none">{SETTINGS_SECTIONS[section].title}</h2><SettingsDescription section={section} id="settings-section-subtitle" className="mt-1" /></div>}
              {/* A page's own buttons beside its title (settingsHeaderActions.tsx). */}
              <div ref={setHeaderSlot} className="flex flex-wrap justify-end gap-2 empty:hidden" />
            </div>
            {leaveWarning && <p role="alert" className="mb-3 text-sm text-destructive">Save your changes before leaving Settings. If a save is in progress, wait for it to finish.</p>}
            <SettingsHeaderSlotProvider value={headerSlot}>
              <SettingControlSlots.Provider value={searching ? slots : null}>
                {settingsSectionRenderers[section]({
                  onOpenSkills, projectPath: project?.path, projectPage: page, row: target, openRequest,
                  onSelectRow: (row) => choose(section, { path: project?.path, row, organization: organization?.id }),
                  organizationId: organization?.id, organizationPage: organizationPageShown, onOpenOrganization: (id) => chooseOrganization(id),
                })}
              </SettingControlSlots.Provider>
            </SettingsHeaderSlotProvider>
            <SectionBadgeLegend section={section} />
          </div>
        </section>
        </div>
      </div>
      <CantSaveToast settingTitle={userKeySettingTitle} />
    </main>
    </SettingsLeaveGuardContext.Provider>
  );
}

/** Beneath a project page's title: its folder and GitHub repository, or what Settings files lists. */
function ProjectPageSubtitle({ project, page }: { project: Project; page: ProjectPage }) {
  const [repository, setRepository] = useState<{ path: string; name: string | null } | null>(null);
  useEffect(() => {
    if (project.kind === "folder") return;
    let live = true;
    Promise.resolve().then(() => issues.githubRepo(project.path)).then((name) => { if (live) setRepository({ path: project.path, name: name ?? null }); }, () => {});
    return () => { live = false; };
  }, [project.path, project.kind]);
  // Actions says what it holds, not where the project is (design 11.06).
  if (page === "actions") return <p className="mt-1 text-[13px] text-muted-foreground">{ACTIONS_SUBTITLE}</p>;
  if (page === "settingsFiles") return <p className="mt-1 text-[13px] text-muted-foreground">Where {project.name}’s values come from, highest first. Edits made in an editor show up here within a second.</p>;
  const name = repository?.path === project.path ? repository.name : null;
  return <p className="mt-1 break-words text-[13px] text-muted-foreground"><span className="font-mono text-[12px]">{shortPath(project.path)}</span>{name && <> · {name}</>}</p>;
}

/**
 * The alerts (role="alert") of the hidden pages a search lists, shown above its results: a refused change made
 * from a result's control is said where the person is looking (Experimental and Orchestrator report a failed
 * save on their page).
 */
function SearchPageAlerts({ root, pages }: { root: RefObject<HTMLElement | null>; pages: readonly { section: SettingsSection; title: string }[] }) {
  const [alerts, setAlerts] = useState<readonly { key: string; title: string; text: string }[]>([]);
  const listed = pages.map((page) => page.section).join(" ");
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const titles = new Map(pages.map((page) => [page.section as string, page.title]));
    const read = () => {
      const next = [...element.querySelectorAll<HTMLElement>("[data-search-page] [role=alert]")].flatMap((alert, index) => {
        const page = alert.closest<HTMLElement>("[data-search-page]")!.dataset.searchPage!;
        const text = alert.textContent?.trim();
        return text && titles.has(page) ? [{ key: `${page}:${index}`, title: titles.get(page)!, text }] : [];
      });
      setAlerts((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
    // `listed` stands for `pages`: the observer restarts when the pages listed change, not on every render.
  }, [root, listed]);
  if (!alerts.length) return null;
  return <div className="mt-3 flex flex-col gap-1">
    {alerts.map((alert) => <p key={alert.key} role="alert" className="text-xs text-destructive">{alert.title}: {alert.text}</p>)}
  </div>;
}

/** The badges a page can show: "Your value" on rows kept in the user file. */
function SectionBadgeLegend({ section }: { section: SettingsSection }) {
  const { file } = useSettingsFile();
  // General's legend sits under Layered configuration, where its "Where this value comes from" popover opens (PRO-374).
  if (section === "general") return null;
  const kinds: readonly SourceBadgeKind[] = file && sectionShowsUserValues(section) ? ["yours"] : [];
  return <BadgeLegend kinds={kinds} />;
}
