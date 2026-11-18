import { idleSuspendCapNote, idleSuspendLabel } from "@/lib/idleSuspend";

/**
 * "Stop when idle" for a new workspace (PRO-410): each window the provider
 * offers under the organization's cap, then Never, with the cap explained
 * when it takes Never away. `choices` come from setup, already ordered.
 */
export function IdleSuspendSelect({
  choices,
  value,
  cap,
  disabled,
  onChange,
  testId = "idle-suspend-select",
}: {
  choices: readonly number[];
  value: number;
  cap: number | null | undefined;
  disabled?: boolean;
  onChange: (minutes: number) => void;
  testId?: string;
}) {
  const note = idleSuspendCapNote(cap, choices);
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Stop when idle
        <select
          className="h-7 rounded-md border border-hairline bg-background px-1 text-xs text-foreground"
          value={value}
          disabled={disabled}
          data-testid={testId}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {choices.map((minutes) => (
            <option key={minutes} value={minutes}>
              {idleSuspendLabel(minutes)}
            </option>
          ))}
        </select>
      </label>
      {note && (
        <span className="text-[11px] text-faint" data-testid={`${testId}-cap`}>
          {note}
        </span>
      )}
    </span>
  );
}
