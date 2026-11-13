// PRO-140 (11.10): every settings file a repository resolves, highest first.
import { AlertCircle, FolderGit2, Lock, RotateCcw, UserRound } from "@/icons";
import { Button } from "@/components/ui/button";
import { fileChips, LAYER_TITLES } from "@/lib/settingSources";
import type { ConfigurationLayer } from "@/types/configuration";
import type { SettingsFileLayer } from "@/types/settingsSources";
import { openSettingsPath, ProblemSentence } from "./SettingSources";

const LAYER_ICONS: Record<ConfigurationLayer, typeof Lock> = {
  managed: Lock,
  repositoryLocal: UserRound,
  repositoryShared: FolderGit2,
  user: UserRound,
  defaults: RotateCcw,
};

export function SettingsFiles({ files, error }: { files: readonly SettingsFileLayer[] | null; error: string | null }) {
  return <section aria-labelledby="settings-files-title" className="flex flex-col gap-2">
    <div>
      <h4 id="settings-files-title" className="text-[13px] font-medium">Settings files</h4>
      <p className="text-xs text-muted-foreground">Where these values come from, highest first. Edits made in an editor show up here within a second.</p>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {files && <ol className="flex flex-col gap-2">
      {files.map((file, index) => {
        const Icon = LAYER_ICONS[file.layer];
        const chips = fileChips(file);
        return <li key={`${file.layer}:${file.path ?? ""}`} data-settings-file={file.layer} className="flex flex-col gap-2 rounded-lg px-3 py-2.5 hairline">
          <div className="flex min-w-0 items-center gap-3">
            <span className="w-3 shrink-0 text-xs text-faint tabular-nums">{index + 1}</span>
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-[13px] font-medium">{LAYER_TITLES[file.layer]}</span>
            {file.displayPath
              ? <span className="min-w-0 truncate font-mono text-xs text-faint" title={file.displayPath}>{file.displayPath}</span>
              : <span className="min-w-0 truncate text-xs text-faint">built into TerminalX</span>}
            {chips.length > 0 && <span className="ml-auto flex shrink-0 gap-1">
              {chips.map((chip) => <span key={chip} className="whitespace-nowrap rounded bg-veil-strong px-1.5 py-0.5 text-xs text-muted-foreground">{chip}</span>)}
            </span>}
          </div>
          {file.problem && file.displayPath && <div role="alert" className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs">
            <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 break-words leading-relaxed"><ProblemSentence file={file.displayPath} problem={file.problem} /></p>
            {file.path && <Button size="sm" variant="outline" className="shrink-0" onClick={() => void openSettingsPath(file.path!, file.displayPath!)}>Open</Button>}
          </div>}
        </li>;
      })}
    </ol>}
  </section>;
}
