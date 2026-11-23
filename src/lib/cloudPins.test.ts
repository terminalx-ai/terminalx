import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saved: { orgs: {} as Record<string, string[]>, adopted: false },
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, errorMessage: (cause: unknown) => String(cause) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => { mocks.listeners.set(event, handler); return () => undefined; }),
}));

/** Fresh modules: a launch, with the window's preferences as `cloudPinned` gives them. */
async function launch(cloudPinned?: Record<string, string[]>) {
  vi.resetModules();
  const prefs = await import("@/lib/prefs");
  if (cloudPinned) prefs.setPrefs({ cloudPinned });
  return { prefs, pins: await import("@/lib/cloudPins") };
}

/** The app's store, as `edit_cloud_pins` keeps it (`store::cloud_pins`). */
function backend(command: string, args?: { edit?: { kind: string; orgId?: string; identity?: string; pinned?: boolean; orgs?: Record<string, string[]>; orgIds?: string[] } }) {
  const edit = args?.edit;
  if (command === "edit_cloud_pins" && edit) {
    const orgs = { ...mocks.saved.orgs };
    if (edit.kind === "adopt") {
      for (const [orgId, list] of Object.entries(edit.orgs ?? {})) orgs[orgId] = [...new Set([...(orgs[orgId] ?? []), ...list])];
      mocks.saved = { orgs, adopted: true };
    } else if (edit.kind === "set") {
      const list = (orgs[edit.orgId!] ?? []).filter((id) => id !== edit.identity);
      orgs[edit.orgId!] = edit.pinned ? [...list, edit.identity!] : list;
      mocks.saved = { ...mocks.saved, orgs };
    } else if (edit.kind === "forget") {
      for (const orgId of edit.orgIds ?? []) delete orgs[orgId];
      mocks.saved = { ...mocks.saved, orgs };
    }
  }
  return Promise.resolve(mocks.saved);
}

beforeEach(() => {
  mocks.invoke.mockReset().mockImplementation(backend);
  mocks.listeners.clear();
  mocks.saved = { orgs: { "org-1": ["github.com/acme/api"] }, adopted: false };
});

describe("cloud pins kept by the app (#1403)", () => {
  it("moves the window's pins over once, then clears them there", async () => {
    const { prefs, pins } = await launch({ "org-1": ["github.com/acme/web"], "org-2": ["blank/notes"] });
    await pins.bootCloudPins();
    expect(mocks.invoke).toHaveBeenCalledWith("edit_cloud_pins", { edit: { kind: "adopt", orgs: { "org-1": ["github.com/acme/web"], "org-2": ["blank/notes"] } } });
    expect(pins.getCloudPins()).toEqual({ "org-1": ["github.com/acme/api", "github.com/acme/web"], "org-2": ["blank/notes"] });
    expect(prefs.getPrefs().cloudPinned).toEqual({});

    // Once moved, a later launch moves nothing again.
    mocks.invoke.mockClear();
    const again = (await launch()).pins;
    await again.bootCloudPins();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["cloud_pins"]);
  });

  it("moves a pin an older build set in the preferences after the move, and clears it there", async () => {
    mocks.saved = { orgs: { "org-1": ["github.com/acme/api"] }, adopted: true };
    // An older build keeps pins in the preferences still: run after the move, it pinned one there.
    const { prefs, pins } = await launch({ "org-1": ["github.com/acme/site"] });
    await pins.bootCloudPins();
    expect(mocks.invoke).toHaveBeenCalledWith("edit_cloud_pins", { edit: { kind: "adopt", orgs: { "org-1": ["github.com/acme/site"] } } });
    expect(pins.getCloudPins()).toEqual({ "org-1": ["github.com/acme/api", "github.com/acme/site"] });
    expect(prefs.getPrefs().cloudPinned).toEqual({});
  });

  it("keeps the window's pins when the app could not be read", async () => {
    mocks.invoke.mockImplementation(async () => { throw new Error("runtime restarting"); });
    const { prefs, pins } = await launch({ "org-1": ["github.com/acme/web"] });
    await pins.bootCloudPins();
    expect(prefs.getPrefs().cloudPinned).toEqual({ "org-1": ["github.com/acme/web"] });
    expect(pins.cloudPinsError()).toContain("runtime restarting");

    // The sidebar shows it until a read succeeds; tried again once the app
    // answers, the error goes and the pins are moved then.
    const { result } = renderHook(() => pins.useCloudPinsError());
    expect(result.current).toContain("runtime restarting");
    mocks.invoke.mockImplementation(backend);
    await act(() => pins.bootCloudPins());
    expect(result.current).toBeNull();
    expect(pins.getCloudPins()).toEqual({ "org-1": ["github.com/acme/api", "github.com/acme/web"] });
    expect(prefs.getPrefs().cloudPinned).toEqual({});
  });

  it("pins through the app, follows another window's or a phone's change, and forgets organizations left", async () => {
    const { pins } = await launch({});
    await pins.bootCloudPins();
    await pins.setCloudProjectPinned("org-2", "github.com/acme/site", true);
    expect(pins.getCloudPins()).toEqual({ "org-1": ["github.com/acme/api"], "org-2": ["github.com/acme/site"] });
    mocks.listeners.get("cloud_pins_changed")!({ payload: { orgs: { "org-2": ["github.com/acme/site"] }, adopted: true } });
    expect(pins.getCloudPins()).toEqual({ "org-2": ["github.com/acme/site"] });
    await pins.pruneCloudPins((orgId) => orgId !== "org-2");
    expect(mocks.invoke).toHaveBeenLastCalledWith("edit_cloud_pins", { edit: { kind: "forget", orgIds: ["org-2"] } });
  });
});
