import { afterEach, describe, expect, it } from "vitest";
import { asSharedSlots, equipSlots, mySlots, readSlotsLink, shareableSlots, slotsLink, SLOTS_LINK_PREFIX, undoEquip } from "@/lib/favouriteSlots";
import { getPrefs, setPrefs, type FavouriteSlot } from "@/lib/prefs";

const opus: FavouriteSlot = { agent: "claude", model: "opus-5-5", effort: "high", mode: "manual", fast: false };
const sol: FavouriteSlot = { agent: "codex", model: "gpt-6.1-sol", effort: "medium", mode: "acceptEdits", fast: true };
const data = (link: string) => link.slice(SLOTS_LINK_PREFIX.length);
const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

afterEach(() => setPrefs({ favouriteSlots: [], lastAgent: "claude", lastModel: {}, lastEffort: {}, lastMode: "manual" }));

describe("favourite model slots", () => {
  it("equips all five of a teammate's slots, slot 1 as the default for new chats, and undoes it", () => {
    setPrefs({ favouriteSlots: [sol], lastAgent: "codex", lastModel: { codex: "gpt-6.1-sol" }, lastEffort: { codex: "medium" }, lastMode: "plan" });
    const undo = equipSlots([opus, null, sol, null, null]);
    expect(mySlots()).toEqual([opus, null, sol, null, null]);
    const prefs = getPrefs();
    expect([prefs.lastAgent, prefs.lastModel.claude, prefs.lastEffort.claude, prefs.lastMode]).toEqual(["claude", "opus-5-5", "high", "manual"]);
    undoEquip(undo);
    expect(mySlots()).toEqual([sol, null, null, null, null]);
    expect([getPrefs().lastAgent, getPrefs().lastMode]).toEqual(["codex", "plan"]);
  });

  it("round-trips a link carrying only agent, model, effort, mode and fast", () => {
    const link = slotsLink("Sam Rivera", [{ ...opus, extra: "x" } as FavouriteSlot, sol]);
    expect(link.startsWith(SLOTS_LINK_PREFIX)).toBe(true);
    expect(readSlotsLink(data(link))).toEqual({ from: "Sam Rivera", slots: [opus, sol, null, null, null] });
  });

  it("never shares or links a mode that skips approvals", () => {
    const bypass = { ...opus, mode: "bypassPermissions" };
    expect(shareableSlots([bypass])[0]).toEqual({ ...opus, mode: null });
    expect(readSlotsLink(data(slotsLink("A", [bypass])))?.slots[0]?.mode).toBeNull();
  });

  it("refuses a link whose slots are cut off, unknown or carry more than the five fields", () => {
    const five = (slot: unknown) => [slot, null, null, null, null];
    for (const body of [
      { v: 1, from: "A", slots: five({ ...opus, mode: "bypassPermissions" }) },
      { v: 1, from: "A", slots: five({ ...opus, model: "https://example.invalid/model" }) },
      { v: 1, from: "A", slots: five({ ...opus, agent: "gemini" }) },
      { v: 1, from: "A", slots: five({ ...opus, effort: "huge" }) },
      { v: 1, from: "A", slots: five({ ...opus, command: "rm -rf" }) },
      { v: 1, from: "A", slots: [opus] },
      { v: 1, from: "A", slots: five(null) },
      { v: 1, from: "A", slots: five(opus), equip: true },
      { v: 2, from: "A", slots: five(opus) },
    ]) expect(readSlotsLink(encode(body)), JSON.stringify(body)).toBeNull();
    expect(readSlotsLink("")).toBeNull();
    expect(readSlotsLink("not-base64!")).toBeNull();
    expect(asSharedSlots([opus, null, null, null, null])).toEqual([opus, null, null, null, null]);
  });
});
