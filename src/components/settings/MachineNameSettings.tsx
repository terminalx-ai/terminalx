import { useEffect, useState } from "react";
import { Loader2, Pencil } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import type { MachineName } from "@/types/pairing";

/**
 * This Mac's name as the user's other Macs show it (#686): their Issues list
 * says "You · on <name>" for work started here. Relay's account directory
 * gets it too. Shown and changed here whether or not Relay is on.
 */
export function MachineNameSettings() {
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
  }, []);

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
  return (
    <div className="rounded-lg border border-hairline px-3 py-2" data-testid="machine-name-settings">
      <div className="flex flex-col gap-1.5 py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div id="machine-name-label" className="text-[13px] font-medium">This Mac’s name</div>
            {draft === null && (
              <div className="truncate text-sm" data-testid="machine-name">
                {machine ? machine.name : <Loader2 className="size-3.5 animate-spin text-faint" aria-label="Loading this Mac’s name" />}
              </div>
            )}
          </div>
          {draft === null && (
            <Button size="sm" variant="outline" className="shrink-0" disabled={!machine} onClick={() => machine && setDraft(machine.name)}>
              <Pencil /> Rename
            </Button>
          )}
        </div>
        {draft !== null && (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed) void save(typed);
            }}
          >
            <input
              autoFocus
              aria-labelledby="machine-name-label"
              value={draft}
              maxLength={80}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDraft(null);
              }}
              className="h-7 min-w-0 flex-1 rounded-md border border-hairline bg-background px-2 text-xs outline-none focus:border-border"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={saving || !typed || typed === machine?.name}>
              {saving ? <Loader2 className="animate-spin" /> : null} Save
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </form>
        )}
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
          <div>
            <Button size="xs" variant="ghost" className="-ml-2" disabled={saving} onClick={() => void save(null)}>
              Use “{computerName}”
            </Button>
          </div>
        )}
      </div>
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
