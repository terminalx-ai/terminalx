import { useEffect, useState } from "react";
import { SettingRow, Switch } from "@/components/ui/controls";
import { agentSettings, errorMessage } from "@/lib/api";

export function CommandApprovalSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => agentSettings.get())
      .then((settings) => live && setEnabled(settings.readOnlyCommands))
      .catch((e) => live && setError(errorMessage(e)));
    return () => { live = false; };
  }, []);

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
      <SettingRow
        label="Allow read-only commands in Ask mode"
        description="Run common discovery commands without an approval card: ls, cat, rg, grep, pwd, and git status, diff and log. Every command in a chain or pipe must qualify. Redirects, shell expansions, unknown options and commands that can run helpers still ask. Turn this off to ask for every command. Commands you explicitly allow for a session keep that allowance in the approved directory until TerminalX restarts."
        control={<Switch aria-label="Allow read-only commands in Ask mode" checked={enabled ?? false} disabled={enabled === null || saving} onCheckedChange={(next) => void change(next)} />}
      />
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
