import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { getPrefs, setPrefs, type FavouriteSlot } from "@/lib/prefs";

const { signedIn, team, showError } = vi.hoisted(() => ({ signedIn: { on: true }, team: { on: true }, showError: vi.fn() }));
function account() {
  return {
    status: (signedIn.on ? {
      state: "signed-in",
      identity: { organizationId: "org-a" },
      organizations: [{ id: "org-a", name: "Fixture Labs", role: "member", isPersonal: false }],
      phase2Readiness: team.on ? { "org-a": ["team.shared-setups.v1"] } : {},
    } : { state: "signed-out" }) as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@/lib/errorToasts", () => ({ showError }));

const { offerSlots, openSlotsLink, SlotsLinkHost } = await import("./EquipSlotsDialog");
const { slotsLink, SLOTS_LINK_PREFIX } = await import("@/lib/favouriteSlots");

const opus: FavouriteSlot = { agent: "claude", model: "opus-5-5", effort: "high", mode: "manual", fast: false };
const sol: FavouriteSlot = { agent: "codex", model: "gpt-6.1-sol", effort: "medium", mode: "acceptEdits", fast: true };
const mine: FavouriteSlot = { agent: "codex", model: "gpt-6.1-terra", effort: "low", mode: "plan", fast: false };

afterEach(() => {
  cleanup();
  signedIn.on = true;
  team.on = true;
  showError.mockReset();
  setPrefs({ favouriteSlots: [] });
});

describe("equipping a teammate's favourite model slots", () => {
  it("shows both sets with their modes, equips only after the confirmation, and offers Undo", () => {
    setPrefs({ favouriteSlots: [mine] });
    render(<SlotsLinkHost />);
    act(() => offerSlots({ name: "Aisha Khan", slots: [opus, sol, null, null, null], organization: "Fixture Labs" }));
    expect(screen.getByText("Use Aisha’s favourite model slots?")).toBeTruthy();
    expect(screen.getByText("Aisha Khan shares these with Fixture Labs. Slot 1 becomes your default model.")).toBeTruthy();
    expect(screen.getByText("Ask every time")).toBeTruthy();
    expect(screen.getByText("Accept edits")).toBeTruthy();
    expect(screen.getByText("Plan")).toBeTruthy();
    // The agent by name, and fast where a slot has it.
    expect(screen.getAllByText("Claude")).toHaveLength(1);
    expect(screen.getAllByText("Codex")).toHaveLength(2);
    expect(screen.getAllByText("Fast")).toHaveLength(1);
    expect(screen.getByText("This replaces your 5 slots. You can undo from the toast that follows.")).toBeTruthy();
    expect(getPrefs().favouriteSlots).toEqual([mine]);
    fireEvent.click(screen.getByRole("button", { name: "Equip" }));
    expect(getPrefs().favouriteSlots).toEqual([opus, sol, null, null, null]);
    expect(getPrefs().lastMode).toBe("manual");
    const [, , options] = showError.mock.calls[0]!;
    expect(options.title).toBe("Using Aisha’s favourite model slots");
    act(() => options.actions[0].run());
    expect(getPrefs().favouriteSlots).toEqual([mine, null, null, null, null]);
  });

  it("does not offer a set with a mode the server refuses", () => {
    render(<SlotsLinkHost />);
    act(() => offerSlots({ name: "A", slots: [{ ...opus, mode: "bypassPermissions" }, null, null, null, null] }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a link only as a confirmation that does not vouch for who it says it is from, and says why when it cannot", () => {
    render(<SlotsLinkHost />);
    const link = slotsLink("Sam Rivera", [sol]);
    act(() => openSlotsLink(link.slice(SLOTS_LINK_PREFIX.length), link));
    expect(screen.getByText("A link wants to set your model slots")).toBeTruthy();
    expect(screen.getByText("It says it is from “Sam Rivera”, which TerminalX can’t check. Slot 1 becomes your default model.")).toBeTruthy();
    expect(screen.queryByText(/Sam’s/)).toBeNull();
    expect(screen.getByText("Opened from a link")).toBeTruthy();
    expect(getPrefs().favouriteSlots).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getPrefs().favouriteSlots).toEqual([]);
    act(() => openSlotsLink(link.slice(SLOTS_LINK_PREFIX.length), link));
    fireEvent.click(screen.getByRole("button", { name: "Equip" }));
    expect(showError.mock.calls.at(-1)![2].title).toBe("Using the model slots from the link");
    team.on = false;
    act(() => openSlotsLink(link.slice(SLOTS_LINK_PREFIX.length), link));
    expect(showError.mock.calls.at(-1)![2].title).toBe("Shared slots aren’t on here");
    expect(screen.queryByRole("dialog")).toBeNull();
    team.on = true;
    act(() => openSlotsLink("", SLOTS_LINK_PREFIX));
    expect(showError.mock.calls.at(-1)![2].title).toBe("This link has no model slots in it");
    signedIn.on = false;
    act(() => openSlotsLink(link.slice(SLOTS_LINK_PREFIX.length), link));
    expect(showError.mock.calls.at(-1)![2].title).toBe("Sign in to use shared slots");
  });
});
