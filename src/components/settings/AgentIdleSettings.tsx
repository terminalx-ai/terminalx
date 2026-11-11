import { useSettingsFile } from "@/lib/settingsFile";
import { RegisteredSetting } from "./settingsRegistry";
import { useEffect, useState } from "react";
import { Segmented } from "@/components/ui/controls";
import { IDLE_STOP_MINUTES, agentSettings, errorMessage } from "@/lib/api";

/** "Never", "30 min", "1 hour", "4 hours", "1 day". */
export function idleLimitLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes === 1440) return "1 day";
  if (minutes === 60) return "1 hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

/**
 * How long an agent the app started may sit idle before it is stopped (#696). The runtime that owns the agents reads
 * the limit itself, at its next look; what this shows is what it was told.
 */
export function AgentIdleSettings() {
  const { revision } = useSettingsFile();
  const [minutes, setMinutes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => agentSettings.get())
      .then((settings) => live && setMinutes(settings.idleStopMinutes))
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [revision]);

  const change = async (next: number) => {
    const before = minutes;
    setMinutes(next);
    setError(null);
    try {
      setMinutes((await agentSettings.setIdleStopMinutes(next)).idleStopMinutes);
    } catch (e) {
      setMinutes(before);
      setError(errorMessage(e));
    }
  };

  return (
    <div className="rounded-lg border border-hairline px-3 py-2" data-testid="agent-idle-settings">
      <RegisteredSetting setting="agents.idleStop"
        stacked
        control={
          <Segmented
            aria-label="Stop idle agents after"
            disabled={minutes === null}
            value={String(minutes ?? 60)}
            onChange={(value) => void change(Number(value))}
            options={IDLE_STOP_MINUTES.map((value) => ({ value: String(value), label: idleLimitLabel(value) }))}
          />
        }
      />
      {error && <p role="alert" className="pb-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
