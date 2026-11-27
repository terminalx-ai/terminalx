import { useEffect, useState, useSyncExternalStore } from "react";
import { Bot, Copy, Sparkles } from "@/icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { useAccount } from "@/lib/account";
import { copyText } from "@/lib/clipboard";
import { showError } from "@/lib/errorToasts";
import { currentModelSlot, mySlots, setSlot, shareableSlots, slotLabel, slotsLink } from "@/lib/favouriteSlots";
import { modeLabel } from "@/lib/models";
import { getPrefs, subscribePrefs } from "@/lib/prefs";
import { sharedSetupsApi, useSharedSetupsOrg } from "@/lib/sharedSetups";
import { RegisteredSetting } from "./settingsRegistry";

const slotsNow = () => getPrefs().favouriteSlots;

/**
 * Settings › Default models (PRO-154): the five favourite model slots, and
 * sharing them with the organization or by a link. Choosing each slot's
 * agent, model and effort in place is PRO-219; until then a slot takes the
 * model new chats start with.
 */
export function DefaultModelsSettings() {
  useSyncExternalStore(subscribePrefs, slotsNow, slotsNow);
  const { status } = useAccount();
  const org = useSharedSetupsOrg();
  const [shared, setShared] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const slots = mySlots();
  const current = currentModelSlot();
  const hasSlots = shareableSlots(slots).some(Boolean);

  useEffect(() => {
    setShared(null);
    if (!org) return;
    let cancelled = false;
    sharedSetupsApi.slots(org.id).then((answer) => { if (!cancelled) setShared(answer.shared); }).catch(() => {});
    return () => { cancelled = true; };
  }, [org]);

  const change = (index: number, slot: typeof current) => {
    setSlot(index, slot);
    const next = mySlots();
    // A shared set follows the person's changes; an emptied one stops being shared.
    if (org && shared) {
      const sync = shareableSlots(next).some(Boolean) ? sharedSetupsApi.shareSlots(org.id, shareableSlots(next)) : sharedSetupsApi.stopSharingSlots(org.id).then(() => setShared(false));
      void sync.catch((error) => showError(`Couldn't update the slots you share with ${org.name}`, error));
    }
  };

  const toggleShare = async (on: boolean) => {
    if (!org || busy) return;
    setBusy(true);
    try {
      if (on) await sharedSetupsApi.shareSlots(org.id, shareableSlots(slots));
      else await sharedSetupsApi.stopSharingSlots(org.id);
      setShared(on);
    } catch (error) {
      showError(on ? `Couldn't share your slots with ${org.name}` : `Couldn't stop sharing your slots`, error);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    const from = status.identity?.name?.trim() || "A teammate";
    await copyText(slotsLink(from, slots));
    showError("Anyone in your organization who opens it can equip these slots.", undefined, { title: "Link copied", key: "slots-link-copied", tone: "success", copy: false });
  };

  return (
    <RegisteredSetting setting="defaultModels.favouriteSlots">
      <section className="flex flex-col gap-3 py-3.5">
        <div>
          <p className="text-[13px] font-medium">Favourite model slots</p>
          <p className="text-xs text-muted-foreground">Slot 1 starts new chats.</p>
        </div>
        <ol className="flex flex-col gap-1.5">
          {slots.map((slot, index) => {
            const label = slot ? slotLabel(slot) : null;
            const Icon = slot?.agent === "claude" ? Sparkles : Bot;
            return (
              <li key={index} className="flex h-10 items-center gap-3 rounded-md border border-hairline px-3 text-xs">
                <span className="w-3 text-faint">{index + 1}</span>
                {slot && label ? (
                  <>
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{label.model}</span>
                    <span className="truncate text-muted-foreground">{[label.effort, slot.mode ? modeLabel(slot.mode) : null].filter(Boolean).join(" · ")}</span>
                    {index === 0 && <span className="rounded bg-accent/15 px-1 text-[10px] text-accent">Default</span>}
                    <Button className="ml-auto" size="xs" variant="ghost" onClick={() => change(index, null)}>Clear</Button>
                  </>
                ) : (
                  <>
                    <span className="text-faint">Empty</span>
                    <Button className="ml-auto" size="xs" variant="ghost" disabled={!current} onClick={() => change(index, current)}>Use the current model</Button>
                  </>
                )}
              </li>
            );
          })}
        </ol>
        <div className="flex items-center gap-3 border-t border-hairline pt-3">
          {org && (
            <label className="flex items-center gap-2 text-xs">
              <Switch aria-label={`Share with ${org.name}`} checked={!!shared} disabled={busy || shared === null || !hasSlots} onCheckedChange={(on) => void toggleShare(on)} />
              Share with {org.name}
            </label>
          )}
          <Button className="ml-auto" size="xs" variant="outline" disabled={!hasSlots} onClick={() => void copyLink()}><Copy />Copy link</Button>
        </div>
      </section>
    </RegisteredSetting>
  );
}
