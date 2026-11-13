import { useState } from "react";
import { RegisteredSetting } from "./settingsRegistry";
import { Button } from "@/components/ui/button";
import { createSettingsFile, useSettingsFile } from "@/lib/settingsFile";
import { AlertCircle } from "@/icons";
import { openSettingsPath, ProblemSentence } from "./SettingSources";

export function SettingsFileError() {
  const { file, error } = useSettingsFile();
  // One error, naming file, line and key, while the file's own problem is known (PRO-140).
  if (file?.problem) {
    return <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-foreground">
      <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 break-words leading-relaxed">
        <ProblemSentence file={file.displayPath} problem={file.problem} />
      </p>
      <Button size="sm" variant="outline" className="shrink-0" onClick={() => void openSettingsPath(file.path, file.displayPath)}>Open</Button>
    </div>;
  }
  if (!error) return null;
  return <p role="alert" className="mb-4 rounded-md border border-destructive/30 p-3 text-xs text-destructive">Settings: {error}. Valid entries remain in use when the file is a JSON object. Otherwise, previous settings or defaults are used. Invalid entries use their previous value or a default.</p>;
}

export function SettingsFileRow() {
  const { file } = useSettingsFile();
  const [busy, setBusy] = useState(false);
  if (!file) return null;
  return <RegisteredSetting setting="general.settingsFile" description={file.path} control={
    file.exists ? <span className="text-xs text-muted-foreground">Reloads when edited</span> :
      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        setBusy(true);
        void createSettingsFile().finally(() => setBusy(false));
      }}>Create settings file</Button>
  } />;
}
