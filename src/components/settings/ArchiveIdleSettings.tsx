import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState } from "react";
import { Segmented } from "@/components/ui/controls";
import { ARCHIVE_IDLE_DAYS, conversationSettings, errorMessage } from "@/lib/api";
import { runIdleArchive } from "@/lib/sessions";

/** "Never", "1 day", "7 days". */
export function archiveLimitLabel(days: number): string {
  if (days === 0) return "Never";
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * How long a conversation may go without a message before it is archived (#718). The runtime that knows what each
 * session is doing reads the limit itself at its next sweep; a change runs one at once, so a shorter limit applies now.
 */
export function ArchiveIdleSettings() {
  const [days, setDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => conversationSettings.get())
      .then((settings) => live && setDays(settings.archiveIdleDays))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);

  const change = async (next: number) => {
    const before = days;
    setDays(next);
    setError(null);
    try {
      setDays((await conversationSettings.setArchiveIdleDays(next)).archiveIdleDays);
    } catch (e) {
      setDays(before);
      setError(errorMessage(e));
      return;
    }
    void runIdleArchive();
  };

  return (
    <div className="mt-3 rounded-lg border border-hairline px-3 py-2" data-testid="archive-idle-settings">
      <RegisteredSetting setting="agents.archiveIdle"
        stacked
        control={
          <Segmented
            aria-label="Archive conversations idle for"
            disabled={days === null}
            value={String(days ?? 7)}
            onChange={(value) => void change(Number(value))}
            options={ARCHIVE_IDLE_DAYS.map((value) => ({ value: String(value), label: archiveLimitLabel(value) }))}
          />
        }
      />
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
