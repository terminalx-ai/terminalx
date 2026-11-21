import type { Bot } from "@/types/bots";
import type { NeedsYou } from "@/types/botItems";
import { MachineHostError } from "@/components/machines/MachineHostError";
import { olderRuntime, refreshNeedsYou } from "@/lib/botItems";
import { useLocalRuntime } from "@/lib/localRuntime";
import { NeedsYouRow, UndeliveredNotes } from "./NeedsYou";

/** The Needs you card's note on the Bots page: how long the oldest has waited. */
export function needsYouNote(needs: NeedsYou | null, now = Date.now()): string {
  const times = (needs?.entries ?? []).map((entry) => Date.parse(entry.at)).filter((at) => !Number.isNaN(at));
  if (times.length === 0) return "Nothing waiting";
  const minutes = Math.max(0, Math.round((now - Math.min(...times)) / 60_000));
  if (minutes < 1) return "oldest waiting under a minute";
  if (minutes < 60) return `oldest waiting ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `oldest waiting ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * What needs you could not be read. An older runtime, one that does not know the work lists, is offered a restart: the
 * app's own runtime knows them.
 */
function NeedsYouError({ error }: { error: string }) {
  const { state } = useLocalRuntime();
  if (olderRuntime(error) && state?.state === "connected") {
    const offer = `runtime_restart_required:${state.epoch}: The TerminalX runtime running is older than this app and keeps no work lists, so what needs you cannot be read. Restart runtime starts the app's own.`;
    return <MachineHostError error={offer} className="mb-2 rounded-md bg-destructive/10 px-3 py-2" onRestarted={refreshNeedsYou} />;
  }
  return (
    <p role="alert" className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] break-words text-destructive" data-testid="bots-needs-you-error">
      Couldn't read what needs you: {error}
    </p>
  );
}

/**
 * The Bots page's Needs you queue (PRO-469, design 23.02): every bot's open question, newest first, each with its
 * recommended answer and Open. Questions from a bot that is not listed (gone, or saved by a newer app) are left out.
 */
export function NeedsYouQueue({ bots, needs, error = null }: { bots: Bot[]; needs: NeedsYou | null; error?: string | null }) {
  const entries = (needs?.entries ?? []).filter((entry) => bots.some((bot) => bot.id === entry.botId));
  // A bot whose list cannot be read: its questions are not known, and it says so.
  const unread = (needs?.counts ?? []).filter((count) => count.error).map((count) => ({ bot: bots.find((bot) => bot.id === count.botId), error: count.error! })).filter((value) => value.bot);
  return (
    <section aria-labelledby="bots-needs-you" data-testid="bots-needs-you">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="bots-needs-you" className="text-[11px] font-medium uppercase tracking-[.08em] text-accent">
          Needs you <span className="ml-1">{entries.length}</span>
        </h2>
        {entries.length > 0 && <p className="text-[12px] text-faint">Answer here, or open the item to read it first.</p>}
      </div>
      {error && <NeedsYouError error={error} />}
      {unread.map(({ bot, error }) => (
        <p key={bot!.id} role="alert" className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] break-words text-destructive" data-testid="bots-needs-you-unread">
          Couldn't read {bot!.name}'s work list, so its questions are not shown: {error}
        </p>
      ))}
      <div className="mb-2 empty:hidden"><UndeliveredNotes bots={bots} botId={null} /></div>
      {error ? null : entries.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline-strong px-4 py-3 text-[12.5px] text-faint">
          Nothing needs you. A bot's questions and approvals wait here.
        </p>
      ) : (
        <div className="divide-y divide-hairline overflow-hidden rounded-lg border border-accent/40 bg-card">
          {entries.map((entry) => {
            const bot = bots.find((value) => value.id === entry.botId)!;
            return <NeedsYouRow key={entry.kind === "item" ? `${entry.botId}#${entry.item.number}` : entry.requestId} bot={bot} entry={entry} />;
          })}
        </div>
      )}
    </section>
  );
}
