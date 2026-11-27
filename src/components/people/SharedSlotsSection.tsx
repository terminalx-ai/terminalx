import { useEffect, useState, useSyncExternalStore } from "react";
import { Bot, Check, Sparkles } from "@/icons";
import { Button } from "@/components/ui/button";
import { asSharedSlots, mySlots, sameSlot, slotLabel } from "@/lib/favouriteSlots";
import { modeLabel } from "@/lib/models";
import { getPrefs, subscribePrefs, type FavouriteSlot } from "@/lib/prefs";
import { sharedSetupsApi, useSharedSetupsOrg, type SharedSlotSet } from "@/lib/sharedSetups";
import { offerSlots } from "./EquipSlotsDialog";

const mineNow = () => getPrefs().favouriteSlots;

/**
 * A teammate's favourite model slots, as they share them with the
 * organization (designs 04.11, 04.13), in their profile. Nothing shows when
 * they share none, or shared setups are off.
 */
export function SharedSlotsSection({ userId, name }: { userId: string; name: string }) {
  const org = useSharedSetupsOrg();
  const [set, setSet] = useState<SharedSlotSet | null>(null);
  useSyncExternalStore(subscribePrefs, mineNow, mineNow);
  useEffect(() => {
    setSet(null);
    if (!org) return;
    let cancelled = false;
    sharedSetupsApi.slots(org.id)
      .then(({ sets }) => {
        if (cancelled) return;
        // Checked as a link's slots are: a set the server should never have sent is not offered.
        const found = sets.find((entry) => entry.userId === userId);
        const slots = found && asSharedSlots(found.slots);
        setSet(found && slots ? { ...found, slots } : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [org, userId]);
  if (!org || !set) return null;
  const mine = mySlots();
  const filled = set.slots.map((slot, index) => ({ slot, index })).filter((entry): entry is { slot: FavouriteSlot; index: number } => !!entry.slot);
  const inUse = (slot: FavouriteSlot) => mine.some((own) => sameSlot(own, slot));
  const allInUse = set.slots.every((slot, index) => slot ? sameSlot(mine[index] ?? null, slot) : !mine[index]);
  return (
    <section aria-label="Favourite model slots" className="mt-3 border-t border-hairline pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium">Favourite model slots <span className="font-normal text-muted-foreground">shared with {org.name}</span></p>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {filled.map(({ slot, index }) => {
          const { model, effort } = slotLabel(slot);
          const Icon = slot.agent === "claude" ? Sparkles : Bot;
          return (
            <li key={index} className="flex min-w-0 items-center gap-2 text-xs">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{model}</span>
              <span className="truncate text-muted-foreground">{[effort, slot.mode ? modeLabel(slot.mode) : null].filter(Boolean).join(" · ")}</span>
              {index === 0 && <span className="shrink-0 rounded bg-accent/15 px-1 text-[10px] text-accent">Default</span>}
              {inUse(slot) && <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-add"><Check className="size-3" />In your slots</span>}
            </li>
          );
        })}
      </ul>
      <div className="mt-2.5 flex justify-end">
        {allInUse
          ? <span className="flex items-center gap-1 text-[11px] text-add"><Check className="size-3" />You use these now</span>
          : <Button size="xs" variant="outline" onClick={() => offerSlots({ name, slots: set.slots, organization: org.name })}>Equip</Button>}
      </div>
    </section>
  );
}
