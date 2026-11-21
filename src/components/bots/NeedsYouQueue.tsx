import type { Bot } from "@/types/bots";
import type { NeedsYou } from "@/types/botItems";
import { NeedsYouRow } from "./NeedsYou";

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
 * The Bots page's Needs you queue (PRO-469, design 23.02): every bot's open question, newest first, each with its
 * recommended answer and Open. Questions from a bot that is not listed (gone, or saved by a newer app) are left out.
 */
export function NeedsYouQueue({ bots, needs }: { bots: Bot[]; needs: NeedsYou | null }) {
  const entries = (needs?.entries ?? []).filter((entry) => bots.some((bot) => bot.id === entry.botId));
  return (
    <section aria-labelledby="bots-needs-you" data-testid="bots-needs-you">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="bots-needs-you" className="text-[11px] font-medium uppercase tracking-[.08em] text-accent">
          Needs you <span className="ml-1">{entries.length}</span>
        </h2>
        {entries.length > 0 && <p className="text-[12px] text-faint">Answer here, or open the item to read it first.</p>}
      </div>
      {entries.length === 0 ? (
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
