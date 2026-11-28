import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/icons", () => new Proxy({}, { has: () => true, get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : prop === "__esModule" ? true : (props: Record<string, unknown>) => <svg {...props} />) }));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: import("react").ReactNode }) => children,
  WithTooltip: ({ children }: { children: import("react").ReactNode }) => children,
  Tooltip: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: import("react").ReactNode }) => children,
  TooltipContent: () => null,
  Kbd: ({ children }: { children: import("react").ReactNode }) => <kbd data-slot="kbd">{children}</kbd>,
  KbdGroup: ({ keys }: { keys: string[] }) => <span data-slot="kbd">{keys.map((k, i) => <kbd key={i}>{k}</kbd>)}</span>,
}));
import type { Bot, BotList, BotPatch } from "@/types/bots";
import { mouseClick } from "@/test/press";

const mocks = vi.hoisted(() => ({
  api: { list: vi.fn(), update: vi.fn(), remove: vi.fn(), pause: vi.fn(), resume: vi.fn(), pauseAll: vi.fn(), resumeAll: vi.fn(), templates: vi.fn(), channels: vi.fn(), chatApps: vi.fn(), chatAppConnect: vi.fn(), chatAppLink: vi.fn(), chatAppUnlink: vi.fn(), chatAppDisconnect: vi.fn(), chatAppAlsoSends: vi.fn() },
  github: vi.fn(),
  linear: vi.fn(),
  roster: vi.fn(),
  account: {
    status: { state: "signed-in", identity: { name: "Paula Owner", email: "owner@example.com", organization: null }, expiresAt: null, lastError: null, organizations: [] as { id: string; name: string; role: string; isPersonal?: boolean }[] },
    ready: true,
    busy: false,
  },
  openRow: vi.fn(),
  switches: { bots: true },
  restart: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, botsApi: mocks.api, gh: { ...real.gh, connectionStatus: mocks.github }, issues: { ...real.issues, linearStatus: mocks.linear } };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/machines", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/machines")>();
  return { ...real, machinesApi: { ...real.machinesApi, restartRuntimeForWindow: mocks.restart } };
});
vi.mock("@/lib/experimentalSettings", () => ({ useExperimentalSettings: () => mocks.switches, getExperimentalSettings: () => mocks.switches }));
vi.mock("@/lib/account", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/account")>()), useAccount: () => mocks.account }));
vi.mock("@/lib/organizationRoster", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/organizationRoster")>()), readOrganizationRoster: mocks.roster }));
vi.mock("@/lib/dataPrivacy", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dataPrivacy")>()), useDataPrivacy: () => ({ enabled: false, managed: false, ready: true }) }));
vi.mock("@/lib/settingsLinks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settingsLinks")>()), openSettingRow: mocks.openRow }));

const { bootBots, resetBotsForTests } = await import("@/lib/bots");
const { resetBotsPageForTests, showBotSettings, showBotsTeam, getBotsPage } = await import("@/lib/botsPage");
const { BotsView } = await import("./BotsView");
const { getSessionStore, openAgents } = await import("@/lib/sessions");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { resetChatAppsForTests } = await import("@/lib/botChatApps");

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, slug: name.toLowerCase(), name, roleTitle: "Security auditor", roleTemplateId: "security-auditor", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...extra,
});
const listOf = (revision: number, bots: Bot[], unreadable = 0): BotList => ({ revision, bots, unreadable });
const ORG = { id: "org-1", name: "Example Org", role: "member" };
/** Every bot's `modified` here: a whole list is saved against it. */
const SEEN = "2026-11-20T10:00:00Z";

let bots: Bot[] = [];
function serve(list: Bot[]) {
  bots = list;
  mocks.api.list.mockResolvedValue(listOf(1, bots));
  mocks.api.update.mockImplementation(async (id: string, patch: BotPatch) => {
    const next = { ...bots.find((value) => value.id === id)!, ...patch } as Bot;
    bots = bots.map((value) => (value.id === id ? next : value));
    return next;
  });
}

async function open(list: Bot[], id: string) {
  serve(list);
  await act(async () => {
    await bootBots();
  });
  render(<TooltipProvider><main><BotsView /></main></TooltipProvider>);
  act(() => showBotSettings(id));
  return within(await screen.findByTestId("bot-settings-page"));
}

const lastPatch = () => mocks.api.update.mock.calls.at(-1)?.[1] as BotPatch;

beforeEach(() => {
  for (const mock of Object.values(mocks.api)) mock.mockReset();
  mocks.api.channels.mockResolvedValue({ mentions: [], posts: [], handle: "@sentry" });
  mocks.github.mockReset().mockResolvedValue({ state: "connected", details: null });
  mocks.linear.mockReset().mockResolvedValue({ connected: false });
  mocks.roster.mockReset();
  mocks.openRow.mockReset();
  mocks.restart.mockReset().mockResolvedValue(undefined);
  mocks.account.status.organizations = [];
  resetBotsPageForTests();
});
afterEach(() => {
  cleanup();
  resetBotsForTests();
  resetChatAppsForTests();
});

describe("Bot settings (PRO-478, design 23.07)", () => {
  it("with no organisation: the five sections, This Mac only, Personal on and kept, the channels' states and the owner", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    expect(page.getByRole("heading", { level: 1 }).textContent).toBe("SentrySecurity auditor");
    expect(page.getAllByTestId("bot-settings-section").map((value) => within(value).getByRole("heading").textContent)).toEqual(["Runs on", "Access", "Works in", "Channels", "Who can ask"]);

    // Runs on: This Mac is chosen; a cloud workspace and another machine are live choices (PRO-482).
    expect(page.getByTestId("bot-runs-on-this-mac").getAttribute("aria-checked")).toBe("true");
    for (const other of ["bot-runs-on-cloud", "bot-runs-on-machine"]) {
      expect((page.getByTestId(other) as HTMLButtonElement).disabled).toBe(false);
      expect(page.getByTestId(other).getAttribute("aria-checked")).toBe("false");
    }
    // Choosing one asks where; with no workspace yet it says how to get one, and nothing moves.
    fireEvent.click(page.getByTestId("bot-runs-on-cloud"));
    expect((await screen.findByTestId("bot-move-none")).textContent).toContain("no cloud workspace yet");
    expect((screen.getByTestId("bot-move-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Full access is the default.
    expect(page.getByTestId("bot-access-full").getAttribute("aria-checked")).toBe("true");

    // Works in: Personal only, and the last place cannot be switched off.
    expect(page.queryAllByTestId("bot-works-in-org")).toHaveLength(0);
    expect(page.getByTestId("bot-works-in-personal-state").textContent).toBe("On");
    expect((page.getByTestId("bot-works-in-switch-personal") as HTMLButtonElement).disabled).toBe(true);

    // Channels: TerminalX on; GitHub and Linear as their connections are; Slack and chat apps wait.
    expect(page.getByTestId("bot-channel-terminalx-state").textContent).toBe("On");
    await waitFor(() => expect(page.getByTestId("bot-channel-github-state").textContent).toBe("Connected"));
    await waitFor(() => expect(page.getByTestId("bot-channel-linear-state").textContent).toBe("Not connected"));
    for (const later of ["bot-channel-slack", "bot-channel-chat-app"]) {
      const connect = within(page.getByTestId(later)).getByRole("button", { name: /Connect/ }) as HTMLButtonElement;
      expect(connect.disabled).toBe(true);
    }
    fireEvent.click(within(page.getByTestId("bot-channel-linear")).getByRole("button", { name: "Manage the Linear connection" }));
    expect(mocks.openRow).toHaveBeenCalledWith("integrations.linear");

    // Who can ask: the owner asks and approves; other people need an organisation.
    expect(page.getByTestId("bot-asker-owner").textContent).toContain("Paula Owner");
    expect(page.getByTestId("bot-asker-owner").textContent).toContain("Can ask and approve");
    expect(page.getByTestId("bot-asker-note").textContent).toBe("Other people can ask once you work in an organisation");

    // No budget or cap anywhere.
    expect(page.queryByText(/budget|cap\b|limit/i)).toBeNull();
  });

  it("with one organisation: its row with what it uses, and its switch adds it to where the bot works", async () => {
    mocks.account.status.organizations = [ORG, { id: "personal-org", name: "Paula's", role: "owner", isPersonal: true }];
    const page = await open([bot("b1", "Sentry")], "b1");
    const rows = page.getAllByTestId("bot-works-in-org");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Example Org");
    expect(rows[0].textContent).toContain("Turn on to let Sentry take work there");

    fireEvent.click(page.getByTestId("bot-works-in-switch-org-1"));
    await waitFor(() => expect(lastPatch()).toEqual({ worksIn: ["personal", "org-1"], ifModified: SEEN }));
    await waitFor(() => expect(page.getByTestId("bot-works-in-org").textContent).toContain("cloud time billed to Example Org"));
    // Two places: Personal may now be switched off.
    expect((page.getByTestId("bot-works-in-switch-personal") as HTMLButtonElement).disabled).toBe(false);
    expect(page.getByTestId("bot-asker-note").textContent).toContain("Only you approve");
  });

  it("an organisation it no longer knows is shown as it is and can be switched off", async () => {
    const page = await open([bot("b1", "Sentry", { worksIn: ["personal", "org-gone"] })], "b1");
    expect(page.getByTestId("bot-works-in-unknown").textContent).toContain("org-gone");
    fireEvent.click(page.getByTestId("bot-works-in-switch-org-gone"));
    await waitFor(() => expect(lastPatch()).toEqual({ worksIn: ["personal"], ifModified: SEEN }));
  });

  it("access: each level is saved as picked; a level a newer app wrote is said plainly", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    for (const level of ["askOutward", "readReport", "full"] as const) {
      fireEvent.click(page.getByTestId(`bot-access-${level}`));
      await waitFor(() => expect(lastPatch()).toEqual({ access: level }));
      await waitFor(() => expect(page.getByTestId(`bot-access-${level}`).getAttribute("aria-checked")).toBe("true"));
    }
    cleanup();
    resetBotsForTests();
    const newer = await open([bot("b2", "Iris", { access: "someday" })], "b2");
    expect(newer.getByTestId("bot-access-unknown").textContent).toContain("“someday”");
    expect(newer.getByTestId("bot-access-unknown").textContent).toContain("Read and report");
    expect(newer.getAllByRole("radio").filter((radio) => radio.getAttribute("aria-checked") === "true").map((radio) => radio.dataset.testid)).toEqual(["bot-runs-on-this-mac"]);
  });

  it("a bot that lives on a cloud workspace says so, and only Bring back is offered", async () => {
    const page = await open([bot("b1", "Sentry", { runsOn: "cloud:org-1:ws-1" })], "b1");
    expect(page.getByTestId("bot-runs-on-cloud").getAttribute("aria-checked")).toBe("true");
    expect((page.getByTestId("bot-runs-on-machine") as HTMLButtonElement).disabled).toBe(true);
    expect(page.getByTestId("bot-runs-on-elsewhere").textContent).toContain("bring it back to this computer first");
    fireEvent.click(page.getByTestId("bot-runs-on-this-mac"));
    expect((await screen.findByTestId("bot-bring-back")).textContent).toContain("Bring Sentry back to this computer?");
  });

  it("a failed save says why", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    mocks.api.update.mockRejectedValueOnce("Unknown access x.");
    fireEvent.click(page.getByTestId("bot-access-readReport"));
    expect((await page.findByTestId("bot-settings-error")).textContent).toBe("Unknown access x.");
  });

  it("who can ask: another bot is added to hand off work, may only ask or hand off, and is removed", async () => {
    const page = await open([bot("b1", "Sentry", { reportsTo: "b2" }), bot("b2", "Atlas", { roleTitle: "CTO", roleTemplateId: "cto" })], "b1");
    mouseClick(page.getByTestId("bot-asker-add"));
    fireEvent.click(await screen.findByTestId("bot-asker-add-bot"));
    await waitFor(() => expect(lastPatch()).toEqual({ whoCanAsk: [{ kind: "bot", id: "b2", may: "handOff" }], ifModified: SEEN }));
    const row = await page.findByTestId("bot-asker");
    expect(row.textContent).toContain("Atlas");
    expect(row.textContent).toContain("CTO · its lead");
    expect(row.textContent).toContain("Can hand off work");

    mouseClick(within(row).getByTestId("bot-asker-may"));
    const choices = (await screen.findAllByRole("menuitemradio")).map((item) => item.textContent);
    expect(choices).toEqual(["Can hand off work", "Can ask"]);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Can ask" }));
    await waitFor(() => expect(lastPatch()).toEqual({ whoCanAsk: [{ kind: "bot", id: "b2", may: "ask" }], ifModified: SEEN }));

    mouseClick(within(await page.findByTestId("bot-asker")).getByTestId("bot-asker-may"));
    fireEvent.click(await screen.findByTestId("bot-asker-remove"));
    await waitFor(() => expect(lastPatch()).toEqual({ whoCanAsk: [], ifModified: SEEN }));
  });

  it("who can ask: a member of an organisation it works in is added to ask; one this version cannot read is shown as it is", async () => {
    mocks.account.status.organizations = [ORG];
    mocks.roster.mockResolvedValue({ members: [{ userId: "u-me", email: "owner@example.com", role: "owner" }, { userId: "u-ak", email: "ak@example.com", displayName: "Avery Kim", role: "member" }], pendingInvites: [], viewerRole: "member", canManageMembers: false, contextRevision: "r" });
    const page = await open([bot("b1", "Sentry", { worksIn: ["personal", "org-1"], whoCanAsk: [{ kind: "team", id: "t1", may: "triage" }] })], "b1");
    expect(page.getByTestId("bot-asker").textContent).toContain("t1");
    expect(page.getByTestId("bot-asker").textContent).toContain("triage");

    mouseClick(page.getByTestId("bot-asker-add"));
    const people = await screen.findAllByTestId("bot-asker-add-person");
    expect(people.map((item) => item.textContent?.trim())).toEqual(["AK Avery Kim"]);
    expect(mocks.roster).toHaveBeenCalledWith("org-1");
    fireEvent.click(people[0]);
    await waitFor(() => expect(lastPatch()).toEqual({ whoCanAsk: [{ kind: "team", id: "t1", may: "triage" }, { kind: "person", id: "u-ak", name: "Avery Kim", may: "ask", org: "org-1", email: "ak@example.com" }], ifModified: SEEN }));
    const person = (await page.findAllByTestId("bot-asker"))[1];
    mouseClick(within(person).getByTestId("bot-asker-may"));
    expect((await screen.findAllByRole("menuitemradio")).map((item) => item.textContent)).toEqual(["Can ask and approve", "Can ask"]);
  });

  it("who can ask: a person whose organisation the bot no longer works in is kept and shown inactive", async () => {
    mocks.account.status.organizations = [ORG];
    const page = await open([bot("b1", "Sentry", { worksIn: ["personal"], whoCanAsk: [{ kind: "person", id: "u-ak", name: "Avery Kim", may: "ask", org: "org-1" }, { kind: "person", id: "u-old", name: "Before orgs", may: "ask" }] })], "b1");
    const [avery, older] = page.getAllByTestId("bot-asker");
    expect(avery.dataset.inactive).toBe("true");
    expect(avery.textContent).toContain("Inactive");
    expect(older.dataset.inactive).toBeUndefined();
    fireEvent.click(page.getByTestId("bot-works-in-switch-org-1"));
    await waitFor(() => expect(page.getAllByTestId("bot-asker")[0].dataset.inactive).toBeUndefined());
  });

  it("signed out, the organisations cannot be known, so one it works in cannot be switched off here", async () => {
    const signedIn = mocks.account.status;
    mocks.account.status = { ...signedIn, state: "signed-out", organizations: [] };
    try {
      const page = await open([bot("b1", "Sentry", { worksIn: ["personal", "org-1"] })], "b1");
      const row = page.getByTestId("bot-works-in-unknown");
      expect(row.textContent).toContain("Sign in");
      expect((page.getByTestId("bot-works-in-switch-org-1") as HTMLButtonElement).disabled).toBe(true);
      expect((page.getByTestId("bot-works-in-switch-personal") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      mocks.account.status = signedIn;
    }
  });

  it("access: arrow keys move between the levels and Space or Enter picks one; the chosen level is the tab stop", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    const full = page.getByTestId("bot-access-full");
    expect([full.tabIndex, page.getByTestId("bot-access-askOutward").tabIndex]).toEqual([0, -1]);
    full.focus();
    // Passing over a level saves nothing (PRO-494): the arrows only move.
    fireEvent.keyDown(full, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(page.getByTestId("bot-access-readReport"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(full);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(mocks.api.update).not.toHaveBeenCalled();
    // A button takes Space and Enter as a click.
    let finish: (value: Bot) => void = () => {};
    mocks.api.update.mockImplementationOnce(() => new Promise<Bot>((resolve) => { finish = resolve; }));
    fireEvent.click(document.activeElement!);
    await waitFor(() => expect(lastPatch()).toEqual({ access: "readReport" }));
    // While it saves, the focus stays where it was, and the cards take no other choice.
    const chosen = page.getByTestId("bot-access-readReport");
    await waitFor(() => expect(chosen.getAttribute("aria-disabled")).toBe("true"));
    expect(document.activeElement).toBe(chosen);
    fireEvent.click(full);
    expect(mocks.api.update).toHaveBeenCalledTimes(1);
    await act(async () => finish(bot("b1", "Sentry", { access: "readReport" })));
    expect(document.activeElement).toBe(chosen);
  });

  it("two sections saved together do not refuse each other, and a list changed elsewhere still is", async () => {
    const page = await open([bot("b1", "Sentry", { worksIn: ["personal", "org-gone", "org-old"] })], "b1");
    const later = "2026-11-20T10:05:00Z";
    let finish: (value: Bot) => void = () => {};
    mocks.api.update.mockImplementationOnce(() => new Promise<Bot>((resolve) => { finish = resolve; }));
    fireEvent.click(page.getByTestId("bot-access-readReport"));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledTimes(1));
    // Works in is changed while the access save is out: it waits for it, then goes against what that save left.
    fireEvent.click(page.getByTestId("bot-works-in-switch-org-gone"));
    expect(mocks.api.update).toHaveBeenCalledTimes(1);
    await act(async () => finish(bot("b1", "Sentry", { access: "readReport", worksIn: ["personal", "org-gone", "org-old"], modified: later })));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({ worksIn: ["personal", "org-old"], ifModified: later });

    // Works in changed elsewhere while the page's own access save was out: the list save goes against the bot as the
    // page showed it, so it is refused rather than undoing that change.
    mocks.api.update.mockImplementationOnce(() => new Promise<Bot>((resolve) => { finish = resolve; }));
    fireEvent.click(page.getByTestId("bot-access-askOutward"));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledTimes(3));
    fireEvent.click(page.getByTestId("bot-works-in-switch-org-old"));
    const latest = "2026-11-20T10:09:00Z";
    await act(async () => finish(bot("b1", "Sentry", { access: "askOutward", worksIn: ["personal", "org-new"], modified: latest })));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledTimes(4));
    // The page last showed the bot as the stand-in server answered the Works in save, at SEEN; not `latest`.
    expect(lastPatch()).toEqual({ worksIn: ["personal"], ifModified: SEEN });
  });

  it("a section waits on its own save; the others stay usable", async () => {
    const page = await open([bot("b1", "Sentry", { worksIn: ["personal", "org-gone"] })], "b1");
    let finish: (value: Bot) => void = () => {};
    mocks.api.update.mockImplementationOnce(() => new Promise<Bot>((resolve) => { finish = resolve; }));
    fireEvent.click(page.getByTestId("bot-access-readReport"));
    await waitFor(() => expect(page.getByTestId("bot-access-full").getAttribute("aria-disabled")).toBe("true"));
    expect((page.getByTestId("bot-works-in-switch-org-gone") as HTMLButtonElement).disabled).toBe(false);
    expect((page.getByTestId("bot-asker-add") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => finish(bot("b1", "Sentry", { access: "readReport", worksIn: ["personal", "org-gone"] })));
  });

  it("is reached from the team table, goes back to it, and the header menu renames and deletes", async () => {
    serve([bot("b1", "Sentry")]);
    await act(async () => {
      await bootBots();
    });
    render(<TooltipProvider><main><BotsView /></main></TooltipProvider>);
    act(() => showBotsTeam());
    fireEvent.click(await screen.findByRole("button", { name: "Sentry's settings" }));
    expect(getBotsPage()).toEqual({ page: "settings", botId: "b1" });
    expect(await screen.findByTestId("bot-settings")).toBeTruthy();

    mouseClick(screen.getByTestId("bot-menu"));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["Agent and model…", "Rename…", "Delete…"]);
    fireEvent.click(screen.getByTestId("bot-menu-rename"));
    fireEvent.change(await screen.findByTestId("bot-rename-input"), { target: { value: "Sentinel" } });
    fireEvent.click(screen.getByTestId("bot-rename-save"));
    await waitFor(() => expect(lastPatch()).toEqual({ name: "Sentinel" }));
    expect(await screen.findByRole("heading", { name: /Sentinel/ })).toBeTruthy();

    mouseClick(screen.getByTestId("bot-menu"));
    fireEvent.click(await screen.findByTestId("bot-menu-delete"));
    // What happens to its sessions and chats (PRO-468's delete), said before it happens.
    expect(await screen.findByText(/^Every session working for Sentinel stops now\./)).toBeTruthy();
    expect(document.body.textContent).toContain("Every session working for Sentinel stops now. Its chats go to the archive, where you can still read them; a session it started stays where it is, in plan mode.");
    mocks.api.remove.mockResolvedValue(undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.api.remove).toHaveBeenCalledWith("b1"));
    await waitFor(() => expect(getBotsPage().page).toBe("team"));

    // It was the only bot: the first-bot page.
    expect(await screen.findByTestId("bots-first")).toBeTruthy();
  });

  it("the agent and model are changed from the menu; another agent starts on its default model", async () => {
    const page = await open([bot("b1", "Sentry", { model: "some-model" })], "b1");
    mouseClick(page.getByTestId("bot-menu"));
    fireEvent.click(await screen.findByTestId("bot-menu-agent"));
    const model = (await screen.findByTestId("bot-agent-model")) as HTMLSelectElement;
    expect(model.value).toBe("some-model");
    fireEvent.click(screen.getByTestId("bot-agent-save"));
    await waitFor(() => expect(lastPatch()).toEqual({ model: "some-model" }));
  });

  // A change that gives the bot more is confirmed by this window; a runtime that cannot verify it is restarted from the
  // error, which then tries the same save again (the lead's N2).
  const RESTART = "runtime_restart_required:epoch-7: TerminalX cannot confirm this window to the runtime running now. Restarting it stops one running session.";

  it("a save the runtime cannot confirm offers Restart runtime, then saves again", async () => {
    const page = await open([bot("b1", "Sentry", { access: "readReport" })], "b1");
    mocks.api.update.mockRejectedValueOnce(RESTART);
    fireEvent.click(page.getByTestId("bot-access-full"));
    const error = await page.findByTestId("bot-settings-error");
    expect(error.textContent).toContain("Restarting it stops one running session.");
    expect(error.textContent).not.toContain("runtime_restart_required");
    fireEvent.click(within(error).getByRole("button", { name: "Restart runtime" }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith("epoch-7", RESTART));
    await waitFor(() => expect(mocks.api.update).toHaveBeenCalledTimes(2));
    expect(mocks.api.update.mock.calls[1]).toEqual(["b1", { access: "full" }]);
    await waitFor(() => expect(page.queryByTestId("bot-settings-error")).toBeNull());
  });

  it("the menu's dialogs offer Restart runtime too, and save again after it", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    for (const [item, act, patch] of [
      ["bot-menu-rename", async () => {
        fireEvent.change(await screen.findByTestId("bot-rename-input"), { target: { value: "Sentinel" } });
        fireEvent.click(screen.getByTestId("bot-rename-save"));
      }, { name: "Sentinel" }],
      ["bot-menu-agent", async () => fireEvent.click(await screen.findByTestId("bot-agent-save")), { model: "" }],
    ] as const) {
      mocks.api.update.mockClear();
      mocks.restart.mockClear();
      mocks.api.update.mockRejectedValueOnce(RESTART);
      mouseClick(page.getByTestId("bot-menu"));
      fireEvent.click(await screen.findByTestId(item));
      await act();
      const error = await screen.findByTestId("bot-menu-error");
      expect(error.textContent).toContain("Restarting it stops one running session.");
      fireEvent.click(within(error).getByRole("button", { name: "Restart runtime" }));
      await waitFor(() => expect(mocks.api.update).toHaveBeenCalledTimes(2));
      expect(mocks.api.update.mock.calls[1]).toEqual(["b1", patch]);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    mocks.api.remove.mockRejectedValueOnce(RESTART).mockResolvedValueOnce(undefined);
    mouseClick(page.getByTestId("bot-menu"));
    fireEvent.click(await screen.findByTestId("bot-menu-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByTestId("bot-menu-error")).getByRole("button", { name: "Restart runtime" }));
    await waitFor(() => expect(mocks.api.remove).toHaveBeenCalledTimes(2));
  });

  it("opening a bot's settings from elsewhere in the app shows the Bots page", () => {
    act(() => openAgents());
    expect(getSessionStore().view).toBe("agents");
    act(() => showBotSettings("b1"));
    expect([getSessionStore().view, getBotsPage()]).toEqual(["bots", { page: "settings", botId: "b1" }]);
  });

  it("a bot that is not in the list says why", async () => {
    const page = await open([bot("b1", "Sentry")], "gone");
    expect(page.getByTestId("bot-settings-missing").textContent).toBe("This bot is no longer here.");
    fireEvent.click(page.getByTestId("bot-settings-back"));
    expect(getBotsPage().page).toBe("team");
  });

  it("GitHub and Linear as channels (PRO-480): how to mention it, what reached it and what it posted, newest first", async () => {
    mocks.linear.mockResolvedValue({ connected: true, viewer: "Paula" });
    mocks.api.channels.mockResolvedValue({
      handle: "@sentry",
      mentions: [
        { id: "github:acme/app:12", thread: { kind: "github", repo: "acme/app", number: 7, title: "Move CI", url: "https://github.com/acme/app/pull/7#c12" }, by: "@stranger", from: "", at: "2026-11-21T10:06:00Z", state: "notAccepted", why: "@stranger is not in Sentry's Who can ask", session: null },
        { id: "linear:c2", thread: { kind: "linear", issue: "PRO-9", title: "Runner", url: "https://linear.app/x/issue/PRO-9#c2" }, by: "Ann", from: "person", at: "2026-11-21T10:00:00Z", state: "delivered", why: "", session: "s1" },
      ],
      posts: [{ bot: "b1", kind: "review", thread: { kind: "github", repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7#r1" }, at: "2026-11-21T10:08:00Z", url: "https://github.com/acme/app/pull/7#r1" }],
    });
    const page = await open([bot("b1", "Sentry")], "b1");
    await waitFor(() => expect(page.getByTestId("bot-channel-github").textContent).toContain("Mention @sentry on a pull request or issue"));
    await waitFor(() => expect(page.getByTestId("bot-channel-linear").textContent).toContain("As Paula · comments on issues it is mentioned in, signed as Sentry's"));
    const activity = within(await page.findByTestId("bot-channel-activity"));
    const rows = activity.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Posted a review");
    expect(rows[0]).toContain("On your behalf");
    expect(rows[1]).toContain("Not accepted");
    expect(rows[1]).toContain("@stranger is not in Sentry's Who can ask");
    expect(rows[2]).toContain("PRO-9 · Runner");
    expect(rows[2]).toContain("In a chat");
    expect(mocks.api.channels).toHaveBeenCalledWith("b1");
  });

  it("a person's GitHub login is given from their row, and saved with the list", async () => {
    const page = await open([bot("b1", "Sentry", { whoCanAsk: [{ kind: "person", id: "u1", name: "Ann", may: "ask", org: "org-1", email: "ann@example.com" }], worksIn: ["personal", "org-1"] })], "b1");
    const row = page.getByTestId("bot-asker");
    expect(row.textContent).toContain("Member");
    mouseClick(within(row).getByTestId("bot-asker-may"));
    fireEvent.click(await screen.findByTestId("bot-asker-github"));
    const input = await screen.findByTestId("bot-asker-github-input");
    fireEvent.change(input, { target: { value: "ann k" } });
    expect((screen.getByTestId("bot-asker-github-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "@ann-k" } });
    fireEvent.click(screen.getByTestId("bot-asker-github-save"));
    await waitFor(() => expect(lastPatch()).toEqual({ whoCanAsk: [{ kind: "person", id: "u1", name: "Ann", may: "ask", org: "org-1", email: "ann@example.com", github: "ann-k" }], ifModified: SEEN }));
  });

  it("Slack and Telegram (PRO-481): a connected Slack says where it is linked; Telegram connects with its token and links a chat by a code", async () => {
    const slack = { service: "slack", connected: true, state: "connected", why: "", account: { name: "Kestrel Studio" }, code: null,
      links: [{ chat: "C1", name: "#security", direct: false, by: "Paula", linked: SEEN }, { chat: "C2", name: "#eng", direct: false, by: "Paula", linked: SEEN }] };
    const telegramOff = { service: "telegram", connected: false, state: "off", why: "", account: null, links: [], code: null };
    const telegramOn = { ...telegramOff, connected: true, state: "connected", account: { name: "@sentry_tx_bot" } };
    let telegram: object = telegramOff;
    mocks.api.chatApps.mockImplementation(async () => ({ services: [slack, telegram], alsoSendsTo: [], activity: [] }));
    mocks.api.chatAppConnect.mockImplementation(async () => {
      telegram = telegramOn;
      return { service: "telegram", account: { name: "@sentry_tx_bot" } };
    });
    mocks.api.chatAppLink.mockImplementation(async () => ({
      services: [slack, { ...telegramOn, code: { expires: SEEN } }], alsoSendsTo: [], activity: [],
      made: { service: "telegram", code: "ABC234", expires: SEEN, link: "https://t.me/sentry_tx_bot?start=ABC234" },
    }));
    const page = await open([bot("b1", "Sentry")], "b1");

    await waitFor(() => expect(page.getByTestId("bot-channel-slack-state").textContent).toBe("Connected"));
    expect(page.getByTestId("bot-channel-slack").textContent).toContain("#security, #eng · replies in the thread it was asked in");
    expect(page.getByTestId("bot-channel-chat-app-state").textContent).toBe("Not connected");
    expect(page.getByTestId("bot-channel-chat-app").textContent).toContain("Message Sentry from your phone's chat app");
    // WhatsApp needs a relay: its row stays off.
    expect((within(page.getByTestId("bot-channel-whatsapp")).getByRole("button", { name: /Connect/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(page.getByTestId("bot-channel-chat-app")).getByRole("button", { name: "Connect Telegram" }));
    const dialog = within(await screen.findByTestId("bot-chat-app-dialog-telegram"));
    expect((dialog.getByTestId("bot-chat-app-connect") as HTMLButtonElement).disabled).toBe(true);
    const token = dialog.getByTestId("bot-chat-app-telegram-token") as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: " 123456789:AAE-token " } });
    fireEvent.click(dialog.getByTestId("bot-chat-app-connect"));
    await waitFor(() => expect(mocks.api.chatAppConnect).toHaveBeenCalledWith("b1", "telegram", { token: "123456789:AAE-token" }));
    fireEvent.click(await dialog.findByTestId("bot-chat-app-link"));
    await waitFor(() => expect(dialog.getByTestId("bot-chat-app-code").textContent).toContain("ABC234"));
    expect(mocks.api.chatAppLink).toHaveBeenCalledWith("b1", "telegram");
    expect(dialog.getByRole("button", { name: "Open in Telegram" })).toBeTruthy();
  });
});
