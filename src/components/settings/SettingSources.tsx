// PRO-140: where a value comes from, on the Settings pages: source badges, the
// row menu of a setting kept in the user file, Open settings.json, the Can't
// save toast and the badges legend. The words come from src/lib/settingSources.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { configuration, type SettingsEditor } from "@/lib/configuration";
import { AlertCircle, Check, ChevronDown, Code, Copy, FileText, FolderGit2, FolderOpen, Lock, UserRound, X } from "@/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { showError } from "@/lib/errorToasts";
import { createSettingsFile, dismissSaveFailure, useSettingsFile, type SettingsFileStatus } from "@/lib/settingsFile";
import {
  cantSaveCopy, cantSaveEffect, cantSaveStays, cantSaveTitle, effectSentence, setUserKeys, SOURCE_BADGES, type SourceBadgeKind,
} from "@/lib/settingSources";
import type { SettingsFileLayer, SettingsFileProblem } from "@/types/settingsSources";
import { settingValueLabel, userKeyDefault } from "./SettingRowActions";

const TONES = {
  managed: "bg-warning/10 text-warning",
  project: "bg-info/10 text-info",
  overrides: "bg-warning/10 text-warning",
  neutral: "bg-veil-strong text-muted-foreground",
} as const;
const BADGE_ICONS = { managed: Lock, project: FolderGit2, overridesProject: UserRound, yours: UserRound } as const;
const badgeClass = "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-xs font-normal [&_svg]:size-3 [&_svg]:shrink-0";

/** A source badge; with `onClick` it is the button that opens "Where this value comes from". */
export function SourceBadge({ kind, ...button }: { kind: SourceBadgeKind } & ComponentProps<"button">) {
  const { label, tone } = SOURCE_BADGES[kind];
  const Icon = BADGE_ICONS[kind];
  const content = <><Icon aria-hidden />{label}</>;
  if (!button.onClick && !button["aria-haspopup"]) return <span data-source-badge={kind} className={cn(badgeClass, TONES[tone])}>{content}</span>;
  return <button type="button" data-source-badge={kind} {...button} className={cn(badgeClass, TONES[tone], "outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring/40", button.className)}>{content}</button>;
}

/** The name of a settings file in a sentence or a button: the repository-relative path for repository files. */
export function shortFileName(displayPath: string): string {
  const repository = displayPath.lastIndexOf("/.terminalx/");
  if (repository >= 0) return displayPath.slice(repository + 1);
  return displayPath.slice(displayPath.lastIndexOf("/") + 1);
}

export const EDITORS: readonly { label: string; id: SettingsEditor }[] = [
  { label: "Cursor", id: "cursor" },
  { label: "VS Code", id: "vscode" },
  { label: "Zed", id: "zed" },
];

/** Open a settings file in its default app or a named one; a failure becomes an error toast. */
export async function openSettingsPath(path: string, displayPath: string, app?: { label: string; id: SettingsEditor }): Promise<void> {
  try {
    await configuration.openFile(path, app?.id ?? null);
  } catch (error) {
    showError(app ? `Couldn’t open ${displayPath} in ${app.label}` : `Couldn’t open ${displayPath}`, error);
  }
}

export async function revealSettingsPath(path: string, displayPath: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (error) {
    showError(`Couldn’t show ${displayPath} in Finder`, error);
  }
}

/** The user file's path as shown; a runtime older than PRO-140 sends only the absolute path. */
export const shownPath = (file: Pick<SettingsFileStatus, "path" | "displayPath">) => file.displayPath || file.path;

/** The user file exists before anything opens it, so an editor never opens nothing. */
async function ensureUserFile(file: SettingsFileStatus): Promise<void> {
  if (!file.exists) await createSettingsFile();
}

/**
 * "Your value" beside the title of a registry row kept in the user file, while
 * the file sets one of the row's keys. The row's one “…” menu (Reset to
 * default, Copy setting link, Saved in …) is SettingRowActions (PRO-374).
 */
export function UserFileRowAccessory({ keys }: { keys: readonly string[] }) {
  const { file } = useSettingsFile();
  if (!file || !setUserKeys(keys, file.setKeys ?? []).length) return null;
  return <SourceBadge kind="yours" />;
}

/**
 * The repository's own settings files (PRO-388), refreshed when they change: the committed
 * `.terminalx/settings.json` and the git-ignored `settings.local.json`, when they exist.
 */
function useProjectSettingsFiles(projectPath: string | undefined): SettingsFileLayer[] {
  const [files, setFiles] = useState<SettingsFileLayer[]>([]);
  useEffect(() => {
    setFiles([]);
    if (!projectPath) return;
    let live = true;
    let stop: (() => void) | undefined;
    const load = () => void configuration.files(projectPath).then(
      (layers) => { if (live) setFiles(layers.filter((layer) => (layer.layer === "repositoryShared" || layer.layer === "repositoryLocal") && layer.exists && !!layer.path)
        .sort((a, b) => Number(b.layer === "repositoryShared") - Number(a.layer === "repositoryShared"))); },
      () => { if (live) setFiles([]); },
    );
    void configuration.watch(projectPath, load).then((unsubscribe) => { if (live) stop = unsubscribe; else unsubscribe(); }, () => {});
    load();
    return () => { live = false; stop?.(); };
  }, [projectPath]);
  return files;
}

/**
 * Open settings.json, top right of every Settings page, with its Open / Open in / Copy path menu.
 * On a project page (PRO-388) it names and opens the project's own file instead: the committed
 * `.terminalx/settings.json`, or the local one when only that exists; the menu also offers yours.
 */
export function OpenSettingsFileButton({ projectPath }: { projectPath?: string }) {
  const { file } = useSettingsFile();
  const projectFiles = useProjectSettingsFiles(projectPath);
  if (!file) return null;
  const userPath = shownPath(file);
  const project = projectFiles.find((layer) => layer.layer === "repositoryShared") ?? projectFiles[0];
  // The file the button names and opens: the project's on a project page, otherwise yours.
  const target = project
    ? { path: project.path!, displayPath: project.displayPath || project.path!, problem: project.problem, ensure: () => Promise.resolve() }
    : { path: file.path, displayPath: userPath, problem: file.problem, ensure: () => ensureUserFile(file) };
  const name = shortFileName(target.displayPath);
  const line = target.problem?.line;
  const broken = !!target.problem;
  const openFile = (path: string, displayPath: string, ensure: () => Promise<void>, app?: (typeof EDITORS)[number]) =>
    void ensure().then(() => openSettingsPath(path, displayPath, app), (error: unknown) => showError(`Couldn’t create ${displayPath}`, error));
  const open = (app?: (typeof EDITORS)[number]) => openFile(target.path, target.displayPath, target.ensure, app);
  const reveal = () => void target.ensure().then(() => revealSettingsPath(target.path, target.displayPath), (error: unknown) => showError(`Couldn’t create ${target.displayPath}`, error));
  const part = "inline-flex h-7 shrink-0 items-center whitespace-nowrap text-xs outline-none hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40";
  return <div data-open-settings-file="" className={cn("flex shrink-0 items-stretch overflow-hidden rounded-md hairline", broken ? "text-destructive" : "text-foreground")}>
    <button type="button" onClick={() => open()} className={cn(part, "gap-1.5 px-2.5 [&_svg]:size-3.5")}>
      <FileText aria-hidden className={broken ? "text-destructive" : "text-muted-foreground"} />
      <span>Open <span className="font-mono">{name}</span>{line != null && <> · line {line}</>}</span>
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`More ways to open ${name}`} className={cn(part, "border-l border-hairline px-1.5 [&_svg]:size-3.5")}><ChevronDown aria-hidden /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem]">
        <DropdownMenuLabel>Open</DropdownMenuLabel>
        {projectFiles.map((layer) => {
          const shown = layer.displayPath || layer.path!;
          return <DropdownMenuItem key={layer.layer} onSelect={() => openFile(layer.path!, shown, () => Promise.resolve())} className="items-start">
            {layer.layer === "repositoryShared" ? <FolderGit2 className="mt-0.5" /> : <UserRound className="mt-0.5" />}
            <span className="flex min-w-0 flex-col"><span>{layer.layer === "repositoryShared" ? "Project settings" : "Your local overrides"}</span><span className="truncate font-mono text-xs text-muted-foreground">{shortFileName(shown)}</span></span>
          </DropdownMenuItem>;
        })}
        <DropdownMenuItem onSelect={() => openFile(file.path, userPath, () => ensureUserFile(file))} className="items-start">
          <UserRound className="mt-0.5" />
          <span className="flex min-w-0 flex-col"><span>Your settings</span><span className="truncate font-mono text-xs text-muted-foreground">{userPath}</span></span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Open {name} in</DropdownMenuLabel>
        <DropdownMenuItem onSelect={reveal}><FolderOpen />Finder</DropdownMenuItem>
        {EDITORS.map((editor) => <DropdownMenuItem key={editor.id} onSelect={() => open(editor)}><Code />{editor.label}</DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyText(target.path).catch((error: unknown) => showError("Couldn’t copy the path", error))}><Copy />Copy path</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

/**
 * A save refused because the user file is invalid (09.43): which file and line,
 * the parser's words, and what stays in effect. It stays until closed, and goes
 * once the file is valid again.
 */
export function CantSaveToast({ settingTitle }: {
  /** The title of the setting kept at a user-file key ("preferences.sendKey"), so the toast names what stayed. */
  settingTitle?: (key: string) => string | undefined;
} = {}) {
  const { file, saveFailure } = useSettingsFile();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const problem = file?.problem;
  if (!file || !problem || !saveFailure) return null;
  const displayPath = shownPath(file);
  const title = cantSaveTitle(displayPath, problem);
  // The setting whose change was refused, and the value it keeps: the file's last good value, else its default.
  const stayed = (saveFailure.keys ?? []).map((key) => ({ key, title: settingTitle?.(`preferences.${key}`) })).find((entry) => entry.title);
  const stayedValue = stayed && settingValueLabel(file.preferences?.[stayed.key] ?? userKeyDefault(`preferences.${stayed.key}`));
  const onCopy = () => {
    window.clearTimeout(reset.current);
    copyText(cantSaveCopy(displayPath, problem)).then(() => setCopy("copied"), () => setCopy("failed"));
    reset.current = window.setTimeout(() => setCopy("idle"), 2000);
  };
  return <div role="alert" aria-labelledby="cant-save-title" data-cant-save="" className="pointer-events-auto fixed right-4 bottom-10 z-(--z-toast) flex w-[26rem] max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-xl bg-popover p-3 text-sm text-card-foreground shadow-surface hairline animate-fade-in">
    <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
    <div className="min-w-0 flex-1">
      <div id="cant-save-title" className="font-medium">{title}</div>
      <p className="mt-0.5 break-words text-xs text-muted-foreground">
        {stayed?.title ? cantSaveStays(stayed.title, stayedValue) : <>{problem.key && <span className="font-mono text-foreground">{problem.key}</span>}{problem.key && ": "}{problem.message.replace(/\.$/, "")}. {cantSaveEffect(problem)}</>}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void openSettingsPath(file.path, displayPath)}><FileText />Open file</Button>
        <Button size="sm" variant="ghost" className="hairline" onClick={onCopy}>
          {copy === "copied" ? <Check className="text-add" /> : <Copy />}
          {copy === "copied" ? "Copied" : copy === "failed" ? "Couldn’t copy" : "Copy error"}
        </Button>
      </div>
    </div>
    <button type="button" aria-label="Close" onClick={() => dismissSaveFailure(saveFailure.id)} className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground"><X className="size-3.5" /></button>
  </div>;
}

const LEGEND: Record<SourceBadgeKind, ReactNode> = {
  managed: "set by a managed policy on this Mac; read-only",
  project: <>committed in the repository’s <span className="font-mono">.terminalx/settings.json</span></>,
  overridesProject: <>your <span className="font-mono">.terminalx/settings.local.json</span>, over the project’s value</>,
  yours: "your own settings",
};

/** The badges a layered value can show, from every layer (Layered configuration). */
export const LAYERED_BADGES: readonly SourceBadgeKind[] = ["managed", "project", "overridesProject", "yours"];

/** The badges a page can show, and what each means. Only badges this build produces are listed. */
export function BadgeLegend({ kinds }: { kinds: readonly SourceBadgeKind[] }) {
  if (!kinds.length) return null;
  return <section aria-label="Badges" className="mt-8 rounded-lg p-4 hairline">
    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Badges</h3>
    <ul className="flex flex-col gap-2">
      {kinds.map((kind) => <li key={kind} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><SourceBadge kind={kind} />{LEGEND[kind]}</li>)}
    </ul>
  </section>;
}

/** One error in one file, as one sentence: file, line, key, the parser's words and what it does. Its text is `problemText`. */
export function ProblemSentence({ file, problem }: { file: string; problem: SettingsFileProblem }) {
  return <><span className="font-mono">{file}</span>{problem.line != null && <> line {problem.line}</>}: {problem.key && <><span className="font-mono">{problem.key}</span> </>}{problem.message.replace(/\.$/, "")}. {effectSentence(problem.effect)}</>;
}
