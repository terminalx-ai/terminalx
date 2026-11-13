// PRO-140: where a value comes from, on the Settings pages: source badges, the
// row menu of a setting kept in the user file, Open settings.json, the Can't
// save toast and the badges legend. The words come from src/lib/settingSources.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { configuration, type SettingsEditor } from "@/lib/configuration";
import { AlertCircle, Check, ChevronDown, Code, Copy, Ellipsis, FileText, FolderGit2, FolderOpen, Lock, RotateCcw, UserRound, X } from "@/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { showError } from "@/lib/errorToasts";
import { createSettingsFile, dismissSaveFailure, resetUserSetting, useSettingsFile, type SettingsFileStatus } from "@/lib/settingsFile";
import {
  cantSaveCopy, cantSaveEffect, cantSaveTitle, effectSentence, setUserKeys, SOURCE_BADGES, type SourceBadgeKind,
} from "@/lib/settingSources";
import type { SettingsFileProblem } from "@/types/settingsSources";

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
 * The trailing parts of a registry row kept in the user file: "Your value" while
 * the file sets one of the row's keys, and the ··· row menu (Reset to default,
 * Saved in …). Nothing until the file's status is known.
 */
export function UserFileRowAccessory({ keys, title }: { keys: readonly string[]; title: string }) {
  const { file } = useSettingsFile();
  const [busy, setBusy] = useState(false);
  if (!file) return null;
  const set = setUserKeys(keys, file.setKeys ?? []);
  const reset = () => {
    setBusy(true);
    void set.reduce((chain, key) => chain.then(() => resetUserSetting(key)), Promise.resolve())
      .catch((error: unknown) => showError(`Couldn’t reset ${title}`, error))
      .finally(() => setBusy(false));
  };
  return <>
    {set.length > 0 && <SourceBadge kind="yours" />}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`${title} actions`} className="-my-1 size-5 shrink-0"><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        <DropdownMenuItem disabled={!set.length || busy} onSelect={reset}><RotateCcw />Reset to default</DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Saved in <span className="font-mono">{shownPath(file)}</span></div>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}

/** Open settings.json, top right of every Settings page, with its Open / Open in / Copy path menu. */
export function OpenSettingsFileButton() {
  const { file } = useSettingsFile();
  if (!file) return null;
  const displayPath = shownPath(file);
  const name = shortFileName(displayPath);
  const line = file.problem?.line;
  const broken = !!file.problem;
  const open = (app?: (typeof EDITORS)[number]) => void ensureUserFile(file).then(() => openSettingsPath(file.path, displayPath, app), (error: unknown) => showError(`Couldn’t create ${displayPath}`, error));
  const reveal = () => void ensureUserFile(file).then(() => revealSettingsPath(file.path, displayPath), (error: unknown) => showError(`Couldn’t create ${displayPath}`, error));
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
        <DropdownMenuItem onSelect={() => open()} className="items-start">
          <UserRound className="mt-0.5" />
          <span className="flex min-w-0 flex-col"><span>Your settings</span><span className="truncate font-mono text-xs text-muted-foreground">{displayPath}</span></span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Open in</DropdownMenuLabel>
        <DropdownMenuItem onSelect={reveal}><FolderOpen />Finder</DropdownMenuItem>
        {EDITORS.map((editor) => <DropdownMenuItem key={editor.id} onSelect={() => open(editor)}><Code />{editor.label}</DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyText(file.path).catch((error: unknown) => showError("Couldn’t copy the path", error))}><Copy />Copy path</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

/**
 * A save refused because the user file is invalid (09.43): which file and line,
 * the parser's words, and what stays in effect. It stays until closed, and goes
 * once the file is valid again.
 */
export function CantSaveToast() {
  const { file, saveFailure } = useSettingsFile();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(reset.current), []);
  const problem = file?.problem;
  if (!file || !problem || !saveFailure) return null;
  const displayPath = shownPath(file);
  const title = cantSaveTitle(displayPath, problem);
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
        {problem.key && <span className="font-mono text-foreground">{problem.key}</span>}{problem.key && ": "}{problem.message.replace(/\.$/, "")}. {cantSaveEffect(problem)}
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
