import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotList, BotPatch } from "@/types/bots";
import { mouseClick } from "@/test/press";

const mocks = vi.hoisted(() => ({
  api: { list: vi.fn(), update: vi.fn(), remove: vi.fn(), pause: vi.fn(), resume: vi.fn(), pauseAll: vi.fn(), resumeAll: vi.fn(), templates: vi.fn() },
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
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return { ...real, botsApi: mocks.api, gh: { ...real.gh, connectionStatus: mocks.github }, issues: { ...real.issues, linearStatus: mocks.linear } };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/experimentalSettings", () => ({ useExperimentalSettings: () => mocks.switches, getExperimentalSettings: () => mocks.switches }));
vi.mock("@/lib/account", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/account")>()), useAccount: () => mocks.account }));
vi.mock("@/lib/organizationRoster", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/organizationRoster")>()), readOrganizationRoster: mocks.roster }));
vi.mock("@/lib/dataPrivacy", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dataPrivacy")>()), useDataPrivacy: () => ({ enabled: false, managed: false, ready: true }) }));
vi.mock("@/lib/settingsLinks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/settingsLinks")>()), openSettingRow: mocks.openRow }));

const { bootBots, resetBotsForTests } = await import("@/lib/bots");
const { resetBotsPageForTests, showBotSettings, showBotsTeam, getBotsPage } = await import("@/lib/botsPage");
const { BotsView } = await import("./BotsView");
const { TooltipProvider } = await import("@/components/ui/tooltip");

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
  mocks.github.mockReset().mockResolvedValue({ state: "connected", details: null });
  mocks.linear.mockReset().mockResolvedValue({ connected: false });
  mocks.roster.mockReset();
  mocks.openRow.mockReset();
  mocks.account.status.organizations = [];
  resetBotsPageForTests();
});
afterEach(() => {
  cleanup();
  resetBotsForTests();
});

describe("Bot settings (PRO-478, design 23.07)", () => {
  it("with no organisation: the five sections, This Mac only, Personal on and kept, the channels' states and the owner", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    expect(page.getByRole("heading", { level: 1 }).textContent).toBe("SentrySecurity auditor");
    expect(page.getAllByTestId("bot-settings-section").map((value) => within(value).getByRole("heading").textContent)).toEqual(["Runs on", "Access", "Works in", "Channels", "Who can ask"]);

    // Runs on: This Mac is the one live choice; the other two wait for the cloud ticket.
    expect(page.getByTestId("bot-runs-on-this-mac").getAttribute("aria-checked")).toBe("true");
    for (const other of ["bot-runs-on-cloud", "bot-runs-on-machine"]) {
      expect((page.getByTestId(other) as HTMLButtonElement).disabled).toBe(true);
      expect(page.getByTestId(other).textContent).toContain("Comes with cloud bots");
    }

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
    await waitFor(() => expect(lastPatch()).toEqual({ whoCanAsk: [{ kind: "team", id: "t1", may: "triage" }, { kind: "person", id: "u-ak", name: "Avery Kim", may: "ask", org: "org-1" }], ifModified: SEEN }));
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

  it("access: arrow keys move between the levels and pick the one reached; the chosen level is the tab stop", async () => {
    const page = await open([bot("b1", "Sentry")], "b1");
    const full = page.getByTestId("bot-access-full");
    expect([full.tabIndex, page.getByTestId("bot-access-askOutward").tabIndex]).toEqual([0, -1]);
    full.focus();
    fireEvent.keyDown(full, { key: "ArrowRight" });
    await waitFor(() => expect(lastPatch()).toEqual({ access: "askOutward" }));
    expect(document.activeElement).toBe(page.getByTestId("bot-access-askOutward"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    await waitFor(() => expect(lastPatch()).toEqual({ access: "full" }));
  });

  it("a section waits on its own save; the others stay usable", async () => {
    const page = await open([bot("b1", "Sentry", { worksIn: ["personal", "org-gone"] })], "b1");
    let finish: (value: Bot) => void = () => {};
    mocks.api.update.mockImplementationOnce(() => new Promise<Bot>((resolve) => { finish = resolve; }));
    fireEvent.click(page.getByTestId("bot-access-readReport"));
    await waitFor(() => expect((page.getByTestId("bot-access-full") as HTMLButtonElement).disabled).toBe(true));
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

  it("a bot that is not in the list says why", async () => {
    const page = await open([bot("b1", "Sentry")], "gone");
    expect(page.getByTestId("bot-settings-missing").textContent).toBe("This bot is no longer here.");
    fireEvent.click(page.getByTestId("bot-settings-back"));
    expect(getBotsPage().page).toBe("team");
  });
});
