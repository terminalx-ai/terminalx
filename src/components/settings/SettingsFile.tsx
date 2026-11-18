import { useState } from "react";
import { RegisteredSetting } from "./settingsRegistry";
import { Button } from "@/components/ui/button";
import { createSettingsFile, useSettingsFile } from "@/lib/settingsFile";
import { shownPath } from "./SettingSources";

/**
 * A settings file that could not be read at all. A file with a known problem (a line and a key) is named only by
 * the red Open settings.json in the header and the Can't save toast (PRO-140, PRO-374; design 09.43).
 */
export function SettingsFileError() {
  const { file, error } = useSettingsFile();
  if (file?.problem || !error) return null;
  return <p role="alert" className="mb-4 rounded-md border border-destructive/30 p-3 text-xs text-destructive">Settings: {error}. Valid entries remain in use when the file is a JSON object. Otherwise, previous settings or defaults are used. Invalid entries use their previous value or a default.</p>;
}

export function SettingsFileRow() {
  const { file } = useSettingsFile();
  const [busy, setBusy] = useState(false);
  if (!file) return null;
  return <RegisteredSetting setting="general.settingsFile" description={<span className="font-mono">{shownPath(file)}</span>} control={
    file.exists ? <span className="text-xs text-muted-foreground">Reloads when edited</span> :
      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        setBusy(true);
        void createSettingsFile().finally(() => setBusy(false));
      }}>Create settings file</Button>
  } />;
}
