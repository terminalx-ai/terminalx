import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { useSessionStore } from "@/lib/sessions";
import { resolveSetting, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingId, type SettingsSection } from "./settingsRegistry";
import { settingsSectionRenderers } from "./sectionRenderers";

/** Legacy section names and stable row ids are both accepted by every existing entry point. */
export type SettingsTab = SettingsSection | SettingId;
export const DEFAULT_SETTINGS_TAB: SettingsTab = "account";

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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [target, setTarget] = useState<string | null>(() => initialTab === initial.id ? initial.id : null);
  const content = useRef<HTMLElement>(null);
  const { projects } = useSessionStore();
  const repositories = projects.filter((project) => !project.archived);
  const project = repositories.find((candidate) => candidate.path === projectPath);

  useEffect(() => {
    setSection(initial.section);
    setProjectPath(initial.section === "repositories" ? initialProjectPath : undefined);
    if (initial.section === "repositories" && initialProjectPath) setExpanded((previous) => new Set([...previous, initialProjectPath]));
    setTarget(initialTab === initial.id ? initial.id : null);
  }, [initial.id, initial.section, initialTab, initialProjectPath, openRequest]);

  // Rows can appear after account/native settings load. Resolve only inside this
  // page and stop observing on navigation, so a late response cannot steal focus.
  useEffect(() => {
    const root = content.current;
    if (!root) return;
    root.scrollTop = 0;
    if (!target) return;
    const reveal = () => {
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
  }, [section, projectPath, target, openRequest]);

  useHotkey("escape", () => {
    if (hasEscapeOverlay()) return false;
    onBack();
  });
  const choose = (next: SettingsSection, path?: string) => {
    setSection(next);
    setProjectPath(path);
    setTarget(null);
  };
  const navClass = (selected: boolean) => cn(
    "w-full min-w-0 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
    selected ? "bg-selected text-foreground" : "text-muted-foreground hover:bg-veil-raised hover:text-foreground",
  );

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-background" aria-label="Settings">
      <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-1 border-b border-hairline pl-[78px] pr-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back to previous page" onClick={onBack}><ArrowLeft /></Button>
        <h1 className="px-1 text-sm font-medium">Settings</h1>
        <Button variant="outline" size="icon-sm" aria-label="Close" onClick={onBack} className="ml-auto shrink-0 bg-raised hover:bg-[color-mix(in_oklab,var(--surface-raised),var(--foreground)_8%)] active:bg-[color-mix(in_oklab,var(--surface-raised),var(--foreground)_14%)]"><X /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-hairline p-3 scrollbar-thin">
          {SETTINGS_GROUPS.map((group, index) => (
            <div key={group} role="group" aria-labelledby={`settings-group-${index}`}>
              <div id={`settings-group-${index}`} className="px-2.5 pb-1 text-[11px] font-medium text-faint">{group}</div>
              {group === "Repositories" ? (
                repositories.length ? repositories.map((repository, repositoryIndex) => {
                  const isExpanded = expanded.has(repository.path);
                  const selected = section === "repositories" && projectPath === repository.path;
                  const childrenId = `settings-repository-${repositoryIndex}`;
                  return <div key={repository.path}>
                    <button type="button" aria-expanded={isExpanded} aria-controls={childrenId} title={repository.path} className={cn(navClass(false), "flex items-center gap-1.5")} onClick={() => setExpanded((previous) => {
                      const next = new Set(previous);
                      if (next.has(repository.path)) next.delete(repository.path); else next.add(repository.path);
                      return next;
                    })}>
                      <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", isExpanded && "rotate-90")} />
                      <span className="truncate">{repository.name}</span>
                    </button>
                    <div id={childrenId} hidden={!isExpanded} className="pl-4">
                      <button type="button" aria-current={selected ? "page" : undefined} className={navClass(selected)} onClick={() => choose("repositories", repository.path)}>Workspace cleanup</button>
                    </div>
                  </div>;
                }) : <p className="px-2.5 py-2 text-xs text-faint">No repositories added.</p>
              ) : Object.entries(SETTINGS_SECTIONS).filter(([, entry]) => entry.group === group).map(([key, entry]) => (
                <button key={key} type="button" aria-current={section === key ? "page" : undefined} onClick={() => choose(key as SettingsSection)} className={navClass(section === key)}>{entry.title}</button>
              ))}
            </div>
          ))}
        </nav>
        <section ref={content} className="min-w-0 flex-1 overflow-y-auto scrollbar-thin" aria-labelledby="settings-section-title">
          <div className="mx-auto w-full max-w-[48rem] p-6 pb-12" key={`${section}:${project?.path ?? ""}`}>
            <h2 id="settings-section-title" className="mb-5 break-words text-xl font-semibold tracking-tight">{section === "repositories" && project ? project.name : SETTINGS_SECTIONS[section].title}</h2>
            {settingsSectionRenderers[section]({ onOpenSkills, onOpenUsage, projectPath: project?.path, row: target, openRequest })}
          </div>
        </section>
      </div>
    </main>
  );
}
