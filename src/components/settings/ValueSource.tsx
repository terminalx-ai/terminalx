// PRO-140 (09.32): the badge on a layered value and its "Where this value comes from" popover.
import { useState } from "react";
import { Check, FileText, RotateCcw } from "@/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { badgeForValue, layerRows, resetFor } from "@/lib/settingSources";
import type { ConfigurationLayer, ConfigurationValue } from "@/types/configuration";
import type { SettingsFileLayer } from "@/types/settingsSources";
import { openSettingsPath, shortFileName, SourceBadge } from "./SettingSources";

export function ValueSource({ value, label, repository, files, onReset }: {
  value: ConfigurationValue;
  /** The setting's name, for the badge's accessible name. */
  label: string;
  repository: boolean;
  /** Settings files of the same project, for each layer's file name and Open. */
  files: readonly SettingsFileLayer[];
  /** Remove the value at `layer`, so the next layer down applies. */
  onReset: (layer: ConfigurationLayer) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const kind = badgeForValue(value);
  if (!kind) return null;
  const rows = layerRows(value, repository);
  const reset = resetFor(value);
  const fileOf = (layer: ConfigurationLayer) => files.find((file) => file.layer === layer && file.path && file.displayPath);
  const source = fileOf(value.source);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <SourceBadge kind={kind} aria-haspopup="menu" aria-label={`${label}: where this value comes from`} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-[23rem] max-w-[calc(100vw-2rem)] p-1.5">
      <div className="px-2 pt-1.5 pb-2">
        <div className="text-[13px] font-medium">Where this value comes from</div>
        <div className="text-xs text-muted-foreground">Highest first. The first layer with a value wins.</div>
      </div>
      <ol aria-label="Layers" className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const file = row.layer === "repositoryLocal" || row.layer === "repositoryShared" ? fileOf(row.layer) : undefined;
          return <li key={row.layer} data-layer={row.layer} aria-current={row.winning ? "true" : undefined}
            className={cn("flex min-h-8 items-center gap-2 rounded-md px-2 text-[13px]", row.winning && "bg-warning/10 ring-1 ring-warning/40")}>
            <span className="shrink-0">{row.title}</span>
            {file?.displayPath && <span className="min-w-0 truncate font-mono text-xs text-faint">{shortFileName(file.displayPath)}</span>}
            <span className={cn("ml-auto max-w-[45%] shrink-0 truncate text-xs", row.value === null ? "text-faint" : "font-mono", row.overridden && "text-faint line-through")}>
              {row.value ?? "not set"}
            </span>
            {row.winning && <Check aria-label="Applies" className="size-3.5 shrink-0 text-warning" />}
          </li>;
        })}
      </ol>
      {(reset || source) && <DropdownMenuSeparator />}
      <div className="flex flex-wrap items-center gap-1">
        {reset && <DropdownMenuItem disabled={busy} className="hairline" onSelect={() => {
          setBusy(true);
          void onReset(reset.layer).finally(() => setBusy(false));
        }}><RotateCcw />{reset.label}</DropdownMenuItem>}
        {source?.path && source.displayPath && <DropdownMenuItem onSelect={() => void openSettingsPath(source.path!, source.displayPath!)}>
          <FileText />Open <span className="font-mono text-xs">{shortFileName(source.displayPath)}</span>
        </DropdownMenuItem>}
      </div>
    </DropdownMenuContent>
  </DropdownMenu>;
}
