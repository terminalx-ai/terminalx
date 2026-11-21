import { Button } from "@/components/ui/button";
import { Checkbox, Segmented } from "@/components/ui/controls";
import { LISTEN_CHOICES, ROOT_WARNING, listenChoice, listeningText, publicCallersText, runsAsText, sudoText } from "@/lib/machineListen";
import type { MachineListen, MachineListenStatus, MachineRunsAs } from "@/types/machines";

const OPTIONS = LISTEN_CHOICES.map((choice) => ({ value: choice.value, label: choice.label, title: choice.exposes }));

/**
 * Where a machine listens, who it answers and who its runtime runs as
 * (PRO-487), for this Mac in Settings → Machines and for a paired machine
 * on its page. `name` is the machine as the sentence says it ("This Mac",
 * "dev-server"). `onChange` absent: shown, not changed (a computer that may
 * not manage it, or a machine without `machine/9`).
 *
 * No Superdesign screen draws this; it is built from the Machines board's
 * parts (a row with a segmented choice, a hairline card, an outlined button).
 */
export function MachineHosting({ name, status, runsAs, busy, onChange }: {
  name: string;
  status: MachineListenStatus;
  runsAs: MachineRunsAs | null;
  busy: boolean;
  onChange?: (listen: MachineListen, allowPublic: boolean) => void;
}) {
  const choice = listenChoice(status.choice);
  const callers = publicCallersText(status);
  const sudo = runsAs ? sudoText(runsAs) : null;
  return (
    <div className="grid gap-2.5 text-[12.5px]" data-testid="machine-hosting" data-listen={status.choice}>
      {status.askPublic && (
        <div role="alert" className="grid gap-2 rounded-lg border border-hairline bg-well px-3.5 py-3" data-testid="machine-hosting-ask-public">
          <p className="text-foreground">
            {name} listens on a public address. Since this update, callers from public addresses are refused until you decide; it stays reachable through the relay and your private networks.
          </p>
          {onChange && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange("all", true)}>
                Keep the public address
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onChange("lan", false)}>
                Close it
              </Button>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-foreground">Where it listens</span>
        {onChange ? (
          <Segmented
            aria-label={`Where ${name} listens`}
            value={status.choice}
            options={OPTIONS}
            disabled={busy}
            // A public address is answered only by its own, explicit choice: moving between choices never carries it along.
            onChange={(next) => onChange(next, false)}
          />
        ) : (
          <span className="text-muted-foreground">{choice.label}</span>
        )}
      </div>
      <p className="text-muted-foreground" data-testid="machine-hosting-listening">
        {choice.exposes} {listeningText(status)}
        {!status.chosen && " Nobody has chosen yet: it listens as it did before this setting."}
      </p>
      {status.choice === "all" &&
        (onChange ? (
          <Checkbox label="Answer callers from public addresses" checked={status.allowPublic} disabled={busy} onChange={(on) => onChange("all", on)} className="text-[12.5px]">
            Answer callers from public addresses
          </Checkbox>
        ) : (
          callers && <p className="text-muted-foreground">{callers}</p>
        ))}
      {runsAs && (
        <p className={runsAs.root ? "text-destructive" : "text-muted-foreground"} data-testid="machine-hosting-runs-as" data-root={runsAs.root}>
          {runsAsText(runsAs)}
          {runsAs.root ? `. ${ROOT_WARNING}` : sudo ? ` · ${sudo}` : "."}
        </p>
      )}
    </div>
  );
}
