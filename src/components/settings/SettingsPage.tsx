import { SettingsFileError } from "./SettingsFile";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, Building2, FlaskConical, HardDrive, Info, Keyboard, KeyRound, Mic, Palette, Plug, Search, Settings2, Smartphone, UserRound, X } from "@/icons";
import type { LucideIcon } from "lucide-react";
import { ProjectGlyph } from "@/components/layout/ProjectRail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { useSessionStore } from "@/lib/sessions";
import { resolveSetting, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingId, type SettingsSection } from "./settingsRegistry";
import { settingsSectionRenderers } from "./sectionRenderers";
import { HighlightedText } from "@/components/ui/HighlightedText";
import { movePaletteSelection, type PaletteNavigationKey } from "@/lib/commandPalette";
import { searchSettingsSections } from "@/lib/settingsSections";

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
  environment: KeyRound,
  transcription: Mic,
  integrations: Plug,
  repositories: HardDrive,
  organizations: Building2,
  storage: HardDrive,
  shortcuts: Keyboard,
  experimental: FlaskConical,
  about: Info,
};

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
  const results = useMemo(() => searchSettingsSections(query), [query]);
  const searching = !!query.trim();
  const changeQuery = (value: string) => {
    setQuery(value);
    setSelected(0);
  };
  const { projects } = useSessionStore();
  const repositories = projects.filter((project) => !project.archived);
  const project = repositories.find((candidate) => candidate.path === projectPath);

  useEffect(() => {
    setSection(initial.section);
    setProjectPath(initial.section === "repositories" ? initialProjectPath : undefined);
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
      // Sign-in links may also open their existing consent dialog. Keep focus there.
      if (!hasEscapeOverlay()) { visible.tabIndex = -1; visible.focus({ preventScroll: true }); }
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [section, projectPath, target, openRequest, selectionRequest]);

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
    setSection(next);
    setProjectPath(path);
    setTarget(row ?? null);
    changeQuery("");
    setSelectionRequest((request) => request + 1);
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
            aria-activedescendant={searching ? results[selected]?.item.id : undefined}
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
                choose(results[selected].item.tab);
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
              {group === "Repositories" ? (
                // One row a repository, its badge and name, opening its settings: no expander holding a single item.
                repositories.length ? repositories.map((repository) => {
                  const selected = section === "repositories" && projectPath === repository.path;
                  return (
                    <button key={repository.path} type="button" title={repository.path} aria-current={selected ? "page" : undefined} className={navClass(selected)} onClick={() => choose("repositories", repository.path)}>
                      <ProjectGlyph project={repository} size={16} />
                      <span className="truncate">{repository.name}</span>
                    </button>
                  );
                }) : <p className="px-2 py-2 text-xs text-faint">No repositories added.</p>
              ) : Object.entries(SETTINGS_SECTIONS).filter(([, entry]) => entry.group === group).map(([key, entry]) => (
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
        <div className="flex min-h-0 flex-1">
        <section ref={content} className="min-w-0 flex-1 overflow-y-auto scrollbar-thin" aria-labelledby={searching ? "settings-results-title" : "settings-section-title"}>
          <div className="mx-auto w-full max-w-[48rem] px-6 pt-6 empty:hidden"><SettingsFileError /></div>
          {searching && <div className="mx-auto w-full max-w-[48rem] p-6">
            <h2 id="settings-results-title" className="mb-3 text-sm font-medium">Settings sections</h2>
            <div ref={resultsRef} id="settings-search-results" role="listbox" aria-label="Settings search results">
              {results.map((match, index) => (
                <button
                  key={match.item.id}
                  id={match.item.id}
                  type="button"
                  role="option"
                  aria-selected={selected === index}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => choose(match.item.tab)}
                  className={cn("flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40", selected === index ? "bg-selected" : "hover:bg-veil-raised")}
                >
                  <span className="text-sm"><HighlightedText text={match.item.primary} ranges={match.primaryRanges} /></span>
                  <span className="text-xs text-muted-foreground"><HighlightedText text={match.item.secondary} ranges={match.secondaryRanges} /></span>
                </button>
              ))}
            </div>
            {!results.length && <p role="status" className="py-6 text-sm text-muted-foreground">No settings match {query.trim()}</p>}
          </div>}
          <div hidden={searching} className="mx-auto w-full max-w-[48rem] p-6 pb-12" key={`${section}:${project?.path ?? ""}`}>
            <h2 ref={headingRef} tabIndex={-1} id="settings-section-title" className="mb-5 break-words text-xl font-semibold tracking-tight outline-none">{section === "repositories" && project ? project.name : SETTINGS_SECTIONS[section].title}</h2>
            {settingsSectionRenderers[section]({ onOpenSkills, onOpenUsage, projectPath: project?.path, row: target, openRequest, onSelectRow: (row) => choose(section, project?.path, row) })}
          </div>
        </section>
        </div>
      </div>
    </main>
  );
}
