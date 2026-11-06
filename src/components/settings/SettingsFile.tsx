import { useState } from "react";
import { RegisteredSetting } from "./settingsRegistry";
import { Button } from "@/components/ui/button";
import { createSettingsFile, useSettingsFile } from "@/lib/settingsFile";

export function SettingsFileError() {
  const { error } = useSettingsFile();
  return error ? <p role="alert" className="mb-4 rounded-md border border-destructive/30 p-3 text-xs text-destructive">Settings file: {error}. Your last valid settings remain in effect.</p> : null;
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
