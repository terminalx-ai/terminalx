import { useSettingsFile } from "@/lib/settingsFile";
import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/controls";
import { agentSettings, errorMessage } from "@/lib/api";

export function CommandApprovalSettings() {
  const { revision } = useSettingsFile();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => agentSettings.get())
      .then((settings) => live && setEnabled(settings.readOnlyCommands))
      .catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, [revision]);

  const change = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      setEnabled((await agentSettings.setReadOnlyCommands(next)).readOnlyCommands);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-hairline px-3 py-2">
      <RegisteredSetting setting="agents.readOnlyCommands"
        control={<Switch aria-label="Allow read-only commands in Ask mode" checked={enabled ?? false} disabled={enabled === null || saving} onCheckedChange={(next) => void change(next)} />}
      />
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
