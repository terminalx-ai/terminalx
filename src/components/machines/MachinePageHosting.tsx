import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { useMachineHosting } from "@/lib/machineListen";
import { pageCard, pageHeading } from "./MachinePageAgents";
import { MachineHosting } from "./MachineHosting";

/**
 * Listening and privileges on a machine's page (PRO-487): where it listens,
 * the one-time question about its public address, and whether its runtime
 * runs as root or can become root. Changing it needs `machine/9` and a
 * computer that manages the machine.
 */
export function MachinePageHosting({ name, client, connected, manage }: { name: string; client: WorkspaceRpcClient | null; connected: boolean; manage: boolean }) {
  const hosting = useMachineHosting(client, connected);
  let body;
  if (hosting.listen) {
    body = (
      <div className="px-3.5 py-3">
        <MachineHosting name={name} status={hosting.listen} runsAs={hosting.runsAs} busy={hosting.busy} onChange={manage ? (listen, allowPublic) => void hosting.setListen(listen, allowPublic) : undefined} />
        {hosting.error && (
          <p role="alert" className="mt-2 text-[12.5px] text-destructive">
            {hosting.error}
          </p>
        )}
      </div>
    );
  } else {
    const text = !connected
      ? `Shown once ${name} is connected.`
      : !hosting.ready
        ? "Reading where it listens…"
        : hosting.error
          ? `Could not read where it listens: ${hosting.error}`
          : `${name} runs a TerminalX that does not say where it listens.`;
    body = <p className="px-3.5 py-3 text-[12.5px] text-muted-foreground">{text}</p>;
  }
  return (
    <section className="grid gap-2.5" data-testid="machine-page-hosting" aria-label="Listening and privileges">
      <h3 className={pageHeading}>Listening and privileges</h3>
      <div className={pageCard}>{body}</div>
    </section>
  );
}
