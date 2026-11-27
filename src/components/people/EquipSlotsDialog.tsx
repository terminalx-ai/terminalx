import { useSyncExternalStore } from "react";
import { ArrowRight, Bot, Check, Link2, Sparkles, TriangleAlert } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { getAccount } from "@/lib/account";
import { showError } from "@/lib/errorToasts";
import { asSharedSlots, equipSlots, mySlots, padSlots, readSlotsLink, slotLabel, undoEquip, SLOT_COUNT } from "@/lib/favouriteSlots";
import { modeLabel } from "@/lib/models";
import type { FavouriteSlot } from "@/lib/prefs";

/** A teammate's set offered for equipping: from their profile, or from a link they sent. */
export interface EquipOffer {
  /** Their full name, for the description: "Aisha Khan shares these with Fixture Labs." */
  name: string;
  slots: (FavouriteSlot | null)[];
  /** The organization the set is shared in; none when it came by a link. */
  organization?: string;
  /** The link it came from, shown at the top. */
  link?: string;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "Aisha's", or "James'" for a name ending in s. */
export const possessive = (name: string) => {
  const first = firstName(name);
  return first.endsWith("s") ? `${first}’` : `${first}’s`;
};

function SlotCell({ slot, theirs }: { slot: FavouriteSlot | null; theirs?: boolean }) {
  if (!slot) {
    return <div className="flex h-9 items-center justify-center rounded-md border border-dashed border-hairline-strong text-[10px] font-medium tracking-wide text-faint">EMPTY</div>;
  }
  const { model, effort } = slotLabel(slot);
  const Icon = slot.agent === "claude" ? Sparkles : Bot;
  return (
    <div className={cn("flex h-9 min-w-0 items-center gap-2 rounded-md border px-2.5 text-xs", theirs ? "border-accent/60 bg-accent/5" : "border-hairline bg-veil")}>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">{model}</span>
      {effort && <span className="shrink-0 text-muted-foreground">{effort}</span>}
      {slot.mode && <span className="ml-auto shrink-0 truncate text-[11px] text-faint">{modeLabel(slot.mode)}</span>}
    </div>
  );
}

/** Equip `offer`, and say so with a way back (design 04.13). */
export function equipWithUndo(offer: EquipOffer) {
  // Equipped only through the confirmation, and only a set that passes the same checks as a link's.
  const slots = asSharedSlots(offer.slots);
  if (!slots) return 0;
  const undo = equipSlots(slots);
  const first = slots[0];
  const label = first ? slotLabel(first) : null;
  const filled = slots.filter(Boolean).length;
  showError(label ? `${label.model}${label.effort ? ` ${label.effort}` : ""} in slot 1 is your default now.` : "", undefined, {
    title: `Using ${possessive(offer.name)} favourite model slots`,
    key: "equip-slots",
    tone: "success",
    copy: false,
    actions: [{ label: "Undo", run: () => undoEquip(undo) }],
  });
  return filled;
}

/** Use a teammate's favourite model slots? (designs 04.11, 04.12). Replaces all five after this confirmation. */
export function EquipSlotsDialog({ offer, onClose }: { offer: EquipOffer; onClose: () => void }) {
  const mine = mySlots();
  const theirs = padSlots(offer.slots);
  const name = possessive(offer.name);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[580px]">
        {offer.link && (
          <p className="mb-3 flex min-w-0 items-center gap-2 rounded-md border border-hairline px-2.5 py-1.5 text-xs text-muted-foreground">
            <Link2 className="size-3.5 shrink-0" />
            <span className="shrink-0">Opened from a link</span>
            <code className="truncate text-faint">{offer.link}</code>
          </p>
        )}
        <DialogTitle className="text-sm font-semibold">Use {name} favourite model slots?</DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground">
          {offer.organization ? `${offer.name} shares these with ${offer.organization}.` : `${offer.name} sent you these slots.`} Slot 1 becomes your default model.
        </DialogDescription>
        <div className="mt-4 grid grid-cols-[1rem_1fr_1rem_1fr] items-center gap-x-2 gap-y-2" role="table" aria-label="Your slots and theirs">
          <span />
          <span className="text-[10px] font-medium tracking-wide text-faint">YOUR SLOTS NOW</span>
          <span />
          <span className="text-[10px] font-medium uppercase tracking-wide text-faint">{name} slots</span>
          {Array.from({ length: SLOT_COUNT }, (_, index) => (
            <div key={index} role="row" className="contents">
              <span className="text-xs text-faint">{index + 1}</span>
              <SlotCell slot={mine[index] ?? null} />
              <ArrowRight className="size-3.5 text-faint" />
              <SlotCell slot={theirs[index] ?? null} theirs />
            </div>
          ))}
        </div>
        <p className="mt-4 flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <TriangleAlert className="size-3.5 shrink-0 text-warning" />
          This replaces your {SLOT_COUNT} slots. You can undo from the toast that follows.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="accent" size="sm" onClick={() => { equipWithUndo(offer); onClose(); }}><Check />Equip</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- terminalx://slots links: one dialog for the app, opened by the link router

let pending: EquipOffer | null = null;
const listeners = new Set<() => void>();
const setPending = (offer: EquipOffer | null) => {
  pending = offer;
  for (const listener of listeners) listener();
};

/** Ask to equip a teammate's set, from wherever it is offered. */
export function offerSlots(offer: EquipOffer) {
  const slots = asSharedSlots(offer.slots);
  if (slots) setPending({ ...offer, slots });
}

/** Follow a `slots` link: the confirmation, or why there is nothing to equip (design 04.12). */
export function openSlotsLink(data: string, link: string) {
  if (getAccount().status.state !== "signed-in") {
    showError("Slots from teammates are tied to your organization. Sign in to TerminalX, then open the link again.", undefined, {
      title: "Sign in to use shared slots", key: "slots-link", tone: "warning", copy: false,
    });
    return;
  }
  const read = readSlotsLink(data);
  if (!read) {
    showError("It may have been cut off when it was pasted. Ask for it to be copied again from Settings › Default models.", undefined, {
      title: "This link has no model slots in it", key: "slots-link", tone: "warning", icon: "link-off", copy: false,
    });
    return;
  }
  setPending({ name: read.from, slots: read.slots, link });
}

export function SlotsLinkHost() {
  const offer = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => pending,
  );
  return offer ? <EquipSlotsDialog offer={offer} onClose={() => setPending(null)} /> : null;
}
