import { useExperimentalSettings } from "@/lib/experimentalSettings";
import { SettingsFileError } from "./SettingsFile";
import { BadgeLegend, CantSaveToast, OpenSettingsFileButton } from "./SettingSources";
import { useSettingsFile } from "@/lib/settingsFile";
import type { SourceBadgeKind } from "@/lib/settingSources";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, Building2, FlaskConical, FolderPlus, HardDrive, Info, Keyboard, KeyRound, Mic, Network, Palette, Plug, Return, Search, Settings2, Smartphone, UserRound, X } from "@/icons";
import type { LucideIcon } from "lucide-react";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { useSessionStore } from "@/lib/sessions";
import { resolveSetting, sectionShowsUserValues, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingId, type SettingsSection } from "./settingsRegistry";
import { settingsSectionRenderers } from "./sectionRenderers";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { movePaletteSelection, type PaletteNavigationKey } from "@/lib/commandPalette";
import { groupSettingsByPage, searchSettings, settingsSearchSummary, type SettingSearchMatch } from "@/lib/settingsSearch";

/** Legacy section names and stable row ids are both accepted by every existing entry point. */
export type SettingsTab = SettingsSection | SettingId;
export const DEFAULT_SETTINGS_TAB: SettingsTab = "account";

/** Each section's icon in the menu: a row is an icon and a word, read at a glance. */
const SECTION_ICONS: Record<SettingsSection, LucideIcon> = {
  account: UserRound,
  devices: Smartphone,
  general: Settings2,
  appearance: Palette,
  agents: Bot,
  orchestrator: Network,
  environment: KeyRound,
  transcription: Mic,
  integrations: Plug,
  projects: FolderPlus,
  repositories: HardDrive,
  organizations: Building2,
  storage: HardDrive,
  shortcuts: Keyboard,
  experimental: FlaskConical,
  about: Info,
};

/** How long a row opened from search or a link stays marked before it fades, and how long the fade takes. */
export const SETTING_HIGHLIGHT_HOLD_MS = 1200;
export const SETTING_HIGHLIGHT_FADE_MS = 700;

/** The listbox option id of a search result. */
const resultId = (id: string) => `settings-result-${id}`;

export function SettingsPage({ onBack, initialTab = DEFAULT_SETTINGS_TAB, initialProjectPath, openRequest = 0, onOpenSkills, onOpenUsage }: {
  onBack: () => void;
  initialTab?: SettingsTab;
  /** The repository instance for a repository-scoped row link. */
  initialProjectPath?: string;
  /** Repeated requests return to the requested row even after navigation within Settings. */
  openRequest?: number;
  onOpenSkills?: () => void;
  onOpenUsage?: () => void;
}) {
  const initial = resolveSetting(initialTab);
  const [section, setSection] = useState<SettingsSection>(initial.section);
  const [projectPath, setProjectPath] = useState<string | undefined>(initial.section === "repositories" ? initialProjectPath : undefined);
  const [target, setTarget] = useState<string | null>(() => initialTab === initial.id ? initial.id : null);
  const content = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [selectionRequest, setSelectionRequest] = useState(0);
  // A section behind a switch in Settings → Experimental is listed, and found, only while the switch is on.
  const orchestratorRuns = useExperimentalSettings()?.orchestratorRuns === true;
  const offered = useCallback((key: string) => key !== "orchestrator" || orchestratorRuns, [orchestratorRuns]);
  // searchSettings reads the Experimental switch itself; orchestratorRuns re-runs it when the switch changes.
  // Grouped by page, pages in order of their best row; `results` is the rows in that displayed order, which ↑/↓ walk.
  const pages = useMemo(() => groupSettingsByPage(searchSettings(query)), [query, orchestratorRuns]);
  const results = useMemo(() => pages.flatMap((page) => page.matches), [pages]);
  const searching = !!query.trim();
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

  useEffect(() => {
    setSection(initial.section);
    setProjectPath((open) => initial.section === "repositories" ? initialProjectPath ?? open : undefined);
    setTarget(initialTab === initial.id ? initial.id : null);
    setQuery("");
    setSelected(0);
    setSelectionRequest((request) => request + 1);
  }, [initial.id, initial.section, initialTab, initialProjectPath, openRequest]);

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
      visible.scrollIntoView?.({ block: "start" });
      highlightRow(visible);
      // Sign-in links may also open their existing consent dialog. Keep focus there.
      if (!hasEscapeOverlay()) { visible.tabIndex = -1; visible.focus({ preventScroll: true }); }
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [section, projectPath, project?.path, target, openRequest, selectionRequest, highlightRow]);

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
    onBack();
  });
  useHotkey("mod+f", () => {
    if (hasEscapeOverlay(resultsRef.current)) return false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, { global: true });
  const choose = (next: SettingsSection, path?: string, row?: SettingId) => {
    if (!row) clearHighlight();
    setSection(next);
    setProjectPath(path);
    setTarget(row ?? null);
    changeQuery("");
    setSelectionRequest((request) => request + 1);
  };
  // A repository row opens on the repository already open, else the first one listed; with none added, on the
  // Repositories page that says so.
  const open = (match: SettingSearchMatch) => {
    if (match.section !== "repositories") return choose(match.section, undefined, match.id);
    const path = project?.path ?? repositories[0]?.path;
    return path ? choose("repositories", path, match.id) : choose("repositories");
  };
  // The project sidebar's rows: 32px, edge to edge with square corners, text 16px in.
  const navClass = (selected: boolean) => cn(
    "-mx-2 flex h-8 w-[calc(100%+1rem)] min-w-0 items-center gap-2.5 px-4 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
    selected ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-selected/50 hover:text-foreground",
  );

  return (
    // The settings menu stands where the project sidebar stands, at its width and in its row style, so opening Settings
    // reads as the sidebar changing what it lists rather than a different screen.
    <main className="flex h-full min-w-0 flex-1 bg-background" aria-label="Settings">
      <aside className="flex h-full min-h-0 w-(--sidebar-w) shrink-0 flex-col border-r border-hairline">
        <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 pl-[78px] pr-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back to previous page" onClick={onBack}><ArrowLeft /></Button>
          <h1 className="px-1 text-sm font-medium">Settings</h1>
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
          {!query && <kbd className="shrink-0 rounded border border-hairline px-1 font-sans text-[10px] text-faint">⌘F</kbd>}
          {query && <Button variant="ghost" size="icon-sm" aria-label="Clear settings search" className="-mr-1.5 size-6" onClick={() => { changeQuery(""); inputRef.current?.focus(); }}><X /></Button>}
          </div>
        <nav aria-label="Settings sections" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3 pt-2 scrollbar-thin">
          {SETTINGS_GROUPS.map((group, index) => (
            <div key={group} role="group" aria-labelledby={`settings-group-${index}`}>
              <div id={`settings-group-${index}`} className="flex h-6 items-center px-2 text-[12px] text-faint">{group}</div>
              {group === "Repositories" && (
                <button type="button" aria-current={section === "projects" ? "page" : undefined} onClick={() => choose("projects")} className={navClass(section === "projects")}>
                  <FolderPlus aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{SETTINGS_SECTIONS.projects.title}</span>
                </button>
              )}
              {group === "Repositories" ? (
                // One row a repository, its badge and name, opening its settings: no expander holding a single item.
                repositories.length ? repositories.map((repository) => {
                  const selected = section === "repositories" && project?.path === repository.path;
                  return (
                    <button key={repository.path} type="button" title={repository.path} aria-current={selected ? "page" : undefined} className={navClass(selected)} onClick={() => choose("repositories", repository.path)}>
                      <ProjectGlyph project={repository} size={16} />
                      <span className="truncate">{repository.name}</span>
                    </button>
                  );
                }) : <p className="px-2 py-2 text-xs text-faint">No repositories added.</p>
              ) : Object.entries(SETTINGS_SECTIONS).filter(([key, entry]) => entry.group === group && offered(key)).map(([key, entry]) => (
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
        {/* Open settings.json, top right of every page (PRO-140). */}
        <div data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center justify-end gap-2 px-3 empty:hidden"><OpenSettingsFileButton /></div>
        <div className="flex min-h-0 flex-1">
        <section ref={content} className={cn(
          "min-w-0 flex-1 overflow-y-auto scrollbar-thin",
          // A row opened from search or a link (data-setting-highlight, set by the reveal above): the selected fill with
          // an accent edge, drawn as spread shadows so the row's layout does not move; it fades back, at once under
          // reduced motion.
          "[&_[data-setting-highlight]]:rounded-md [&_[data-setting-highlight]]:transition-[background-color,box-shadow] [&_[data-setting-highlight]]:duration-700 [&_[data-setting-highlight]]:ease-out motion-reduce:[&_[data-setting-highlight]]:transition-none",
          "[&_[data-setting-highlight=on]]:bg-selected [&_[data-setting-highlight=on]]:shadow-[0_0_0_6px_var(--color-selected),0_0_0_7px_color-mix(in_oklab,var(--color-accent)_40%,transparent)]",
        )} aria-labelledby={searching ? "settings-results-title" : "settings-section-title"}>
          <div className="mx-auto w-full max-w-[48rem] px-6 pt-6 empty:hidden"><SettingsFileError /></div>
          {searching && <div className="mx-auto w-full max-w-[48rem] p-6">
            {/* Design 09.31: the query as the page title, the count and the keys beneath it, then the rows by page. */}
            <h2 id="settings-results-title" className="break-words text-xl font-semibold tracking-tight">Results for “{query.trim()}”</h2>
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
                        <button
                          key={match.id}
                          id={resultId(match.id)}
                          type="button"
                          role="option"
                          aria-selected={current}
                          onMouseEnter={() => setSelected(index)}
                          onClick={() => open(match)}
                          className={cn(
                            "flex w-full items-center gap-5 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                            current ? "bg-selected ring-1 ring-accent/40" : "hover:bg-veil-raised",
                          )}
                        >
                          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex min-w-0 flex-1 flex-col [&_mark]:rounded-[3px] [&_mark]:bg-accent/25 [&_mark]:px-px [&_mark]:[font-weight:inherit]">
                            <span className="text-sm font-medium"><HighlightedText text={match.row.title} ranges={match.titleRanges} /></span>
                            <span className="text-[12.5px] text-muted-foreground"><HighlightedText text={match.row.description} ranges={match.descriptionRanges} /></span>
                          </span>
                          {current && <Return aria-hidden className="size-3.5 shrink-0 text-faint" />}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* Design 09.33. */}
            {!results.length && <div role="status" className="py-6 text-center">
              <p className="text-sm text-muted-foreground">No settings match “{query.trim()}”</p>
              <p className="mt-1 text-[12px] text-faint">Try fewer letters, or <button type="button" className="text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => choose("shortcuts")}>search keyboard shortcuts</button>.</p>
            </div>}
          </div>}
          <div hidden={searching} className="mx-auto w-full max-w-[48rem] p-6 pb-12" key={`${section}:${project?.path ?? ""}`}>
            <h2 ref={headingRef} tabIndex={-1} id="settings-section-title" className="mb-5 break-words text-xl font-semibold tracking-tight outline-none">{section === "repositories" && project ? project.name : SETTINGS_SECTIONS[section].title}</h2>
            {settingsSectionRenderers[section]({ onOpenSkills, onOpenUsage, projectPath: project?.path, row: target, openRequest, onSelectRow: (row) => choose(section, project?.path, row) })}
            <SectionBadgeLegend section={section} />
          </div>
        </section>
        </div>
      </div>
      <CantSaveToast />
    </main>
  );
}

/**
 * The badges a page can show. General holds Layered configuration, whose values
 * come from every layer; other pages show "Your value" on rows kept in the user file.
 */
const LAYERED_BADGES: readonly SourceBadgeKind[] = ["managed", "project", "overridesProject", "yours"];
function SectionBadgeLegend({ section }: { section: SettingsSection }) {
  const { file } = useSettingsFile();
  const kinds: readonly SourceBadgeKind[] = section === "general" ? LAYERED_BADGES : file && sectionShowsUserValues(section) ? ["yours"] : [];
  return <BadgeLegend kinds={kinds} />;
}
