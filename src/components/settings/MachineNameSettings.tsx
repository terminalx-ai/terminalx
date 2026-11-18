import { useSettingsFile } from "@/lib/settingsFile";
import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import type { MachineName } from "@/types/pairing";

/**
 * This Mac's name as the user's other Macs show it (#686): their Issues list
 * says "You · on <name>" for work started here. Relay's account directory
 * gets it too. Shown and changed here whether or not Relay is on.
 */
export function MachineNameSettings() {
  const { revision } = useSettingsFile();
  const [machine, setMachine] = useState<MachineName | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.machineName())
      .then((found) => live && setMachine(found ?? null))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [revision]);

  const save = async (name: string | null) => {
    setSaving(true);
    setError(null);
    try {
      setMachine(await api.setMachineName(name));
      setDraft(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const typed = draft?.trim() ?? "";
  const computerName = machine?.computerName ?? null;
  // Saves a changed, non-empty name; an empty or unchanged one goes back to the saved name.
  const commit = () => {
    if (draft === null || saving) return;
    if (!typed || typed === machine?.name) setDraft(null);
    else void save(typed);
  };
  return (
    <RegisteredSetting setting="account.machineName"><div className="py-1" data-testid="machine-name-settings">
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="min-w-0">
          <label id="machine-name-label" htmlFor="machine-name" className="text-[13px] font-medium">This Mac’s name</label>
          {machine && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Your other Macs show work started here as “You · on {machine.name}”.{" "}
              {!machine.chosen
                ? "It is the name in System Settings → General → About, and changes with it."
                : computerName && computerName !== machine.name
                  ? `In System Settings this Mac is called “${computerName}”.`
                  : null}
            </p>
          )}
          {machine?.chosen && computerName && computerName !== machine.name && draft === null && (
            <Button size="xs" variant="link" className="h-auto px-0 text-xs text-accent" disabled={saving} onClick={() => void save(null)}>
              Use “{computerName}”
            </Button>
          )}
        </div>
        <div className="relative w-64 max-w-[45%] shrink-0">
          <input
            id="machine-name"
            data-testid="machine-name"
            value={draft ?? machine?.name ?? ""}
            placeholder={machine ? undefined : "Loading…"}
            disabled={!machine}
            maxLength={80}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                setDraft(null);
                setError(null);
              }
            }}
            className="h-8 w-full rounded-md border border-hairline bg-well px-2.5 pr-7 text-[13px] outline-none focus:border-ring disabled:opacity-60"
          />
          {saving && <Loader2 className="absolute top-2 right-2 size-4 animate-spin text-faint" aria-label="Saving this Mac’s name" />}
        </div>
      </div>
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div></RegisteredSetting>
  );
}
