import { useEffect, useState } from "react";
import { Segmented, SettingRow } from "@/components/ui/controls";
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
  }, []);

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
      <SettingRow
        label="Stop idle agents after"
        description="An agent sitting at its prompt still holds its memory, its MCP servers and its language server. Once it has had nothing to do for this long it is stopped; its conversation stays, and your next message starts it again where it left off. An agent at work, waiting for your answer, or waiting on something it started (a background command, monitor or agent, a wakeup or scheduled job, a process it left running) keeps running, and so does one you started yourself in a terminal. An agent in an archived session, or one whose workspace was removed, is stopped after 10 idle minutes."
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
