import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, BotList, BotRoleTemplate } from "@/types/bots";

const mocks = vi.hoisted(() => ({
  api: {
    list: vi.fn(),
    templates: vi.fn(),
    create: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    pauseAll: vi.fn(),
    resumeAll: vi.fn(),
  },
  switches: { bots: true } as { bots: boolean } | null,
}));

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), botsApi: mocks.api }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/experimentalSettings", () => ({ useExperimentalSettings: () => mocks.switches }));

const { bootBots, resetBotsForTests } = await import("@/lib/bots");
const { resetBotsPageForTests, showHireBot, showBotsTeam } = await import("@/lib/botsPage");
const { getSessionStore } = await import("@/lib/sessions");
const { BotsView } = await import("./BotsView");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { BotsSidebarSection, NO_BOTS_TEXT } = await import("./BotsSidebarSection");
const { groupRoles } = await import("./HireBot");
const { accessLabel, roleDuties } = await import("./botLabels");

const bot = (id: string, name: string, extra: Partial<Bot> = {}): Bot => ({
  id, slug: name.toLowerCase(), name, roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...extra,
});
const listOf = (revision: number, bots: Bot[], unreadable = 0): BotList => ({ revision, bots, unreadable });
const template = (id: string, title: string): BotRoleTemplate => ({
  id, title, description: `${title} does its job.`, role: `# ${title}\n\n## What you do\n\n- First thing for ${title}.\n- Second thing.\n\n## How you work\n\n- Not listed.\n`,
  skills: ["code-review"], duties: [{ id: `${id}-duty`, title: `Duty of ${title}`, description: "", wake: { kind: "github", event: "pull_request" }, enabled: false }],
});
const TEMPLATES = [template("cto", "CTO"), template("watcher", "Watcher"), template("security-auditor", "Security auditor"), template("mystery", "Mystery role")];

function Screen() {
  return (
    <TooltipProvider>
      <nav aria-label="Sidebar"><BotsSidebarSection /></nav>
      <main><BotsView /></main>
    </TooltipProvider>
  );
}

async function boot(list: BotList | Error) {
  if (list instanceof Error) mocks.api.list.mockRejectedValue(list);
  else mocks.api.list.mockResolvedValue(list);
  await act(async () => {
    await bootBots();
  });
}

const sidebar = () => within(screen.getByRole("navigation", { name: "Sidebar" }));
const main = () => within(screen.getByRole("main"));

beforeEach(() => {
  for (const mock of Object.values(mocks.api)) mock.mockReset();
  mocks.api.templates.mockResolvedValue(TEMPLATES);
  mocks.switches = { bots: true };
  resetBotsPageForTests();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  resetBotsForTests();
});

describe("Bots: the sidebar section and the first-bot page (PRO-467)", () => {
  it("shows nothing while the experimental switch is off", async () => {
    mocks.switches = { bots: false };
    await boot(listOf(1, [bot("1", "Atlas")]));
    render(<TooltipProvider><BotsSidebarSection /></TooltipProvider>);
    expect(screen.queryByTestId("bots-sidebar-section")).toBeNull();
  });

  it("with no bots: the sidebar's short empty text and the first-bot page with three roles", async () => {
    await boot(listOf(0, []));
    render(<Screen />);
    expect(sidebar().getByText(NO_BOTS_TEXT)).toBeTruthy();
    expect(await main().findByText("Hire your first bot")).toBeTruthy();
    await waitFor(() => expect(main().getAllByTestId("bots-role-card").map((card) => card.dataset.role)).toEqual(["cto", "watcher", "security-auditor"]));
    expect(main().getByRole("button", { name: /All 4 roles/ })).toBeTruthy();
    expect(main().getByText("A bot")).toBeTruthy();
  });

  it("never says there are no bots when records exist that cannot be read", async () => {
    await boot(listOf(2, [], 2));
    render(<Screen />);
    expect(sidebar().queryByText(NO_BOTS_TEXT)).toBeNull();
    expect(sidebar().getByTestId("bots-sidebar-unreadable").textContent).toMatch(/2 bots were saved by a newer TerminalX/);
    expect(main().queryByText("Hire your first bot")).toBeNull();
    expect(main().getByTestId("bots-unreadable")).toBeTruthy();
  });

  it("never says there are no bots when they could not be read", async () => {
    await boot(new Error("store is locked"));
    render(<Screen />);
    expect(sidebar().queryByText(NO_BOTS_TEXT)).toBeNull();
    expect(sidebar().getByRole("alert").textContent).toMatch(/store is locked/);
    expect(main().queryByText("Hire your first bot")).toBeNull();
  });

  it("hires from a first-bot card in one click: the bot shows in the sidebar and the table at once", async () => {
    await boot(listOf(0, []));
    mocks.api.create.mockResolvedValue(bot("b1", "CTO"));
    render(<Screen />);
    fireEvent.click(await main().findByRole("button", { name: "Hire CTO" }));
    await waitFor(() => expect(mocks.api.create).toHaveBeenCalledWith("cto", "CTO"));
    await waitFor(() => expect(sidebar().getAllByTestId("bot-row")).toHaveLength(1));
    expect(sidebar().queryByText(NO_BOTS_TEXT)).toBeNull();
    expect(main().getAllByTestId("bots-table-row").map((row) => row.dataset.bot)).toEqual(["b1"]);
  });
});

describe("Bots: hiring (23.03)", () => {
  it("asks for a name and nothing else, hires with the picked role, then shows the team", async () => {
    await boot(listOf(0, []));
    mocks.api.create.mockResolvedValue(bot("b2", "Argus", { roleTemplateId: "watcher", roleTitle: "Watcher" }));
    act(() => showHireBot("watcher"));
    render(<Screen />);
    await waitFor(() => expect(main().getByRole("heading", { name: "Watcher" })).toBeTruthy());
    // What it does comes from the role's own text; every duty starts off.
    expect(main().getByText("First thing for Watcher.")).toBeTruthy();
    expect(main().queryByText("Not listed.")).toBeNull();
    const duty = main().getByRole("switch", { name: /Duty of Watcher/ });
    expect(duty.getAttribute("aria-checked")).toBe("false");
    const submit = main().getByTestId("bots-hire-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const form = main().getByTestId("bots-hire-form");
    expect(within(form).getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(main().getByTestId("bots-hire-name"), { target: { value: "  Argus " } });
    expect(submit.textContent).toMatch(/Hire Argus/);
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.api.create).toHaveBeenCalledWith("watcher", "Argus"));
    await waitFor(() => expect(main().getByTestId("bots-team")).toBeTruthy());
    expect(main().getAllByTestId("bots-table-row").map((row) => row.dataset.bot)).toEqual(["b2"]);
    expect(sidebar().getByRole("button", { name: /Argus, Watcher/ })).toBeTruthy();
    expect(getSessionStore().view).toBe("bots");
  });

  it("keeps the name and says why when hiring is refused", async () => {
    await boot(listOf(0, []));
    mocks.api.create.mockRejectedValue("A bot named Argus already exists.");
    act(() => showHireBot("watcher"));
    render(<Screen />);
    const input = await main().findByTestId("bots-hire-name");
    fireEvent.change(input, { target: { value: "Argus" } });
    fireEvent.click(main().getByTestId("bots-hire-submit"));
    expect((await main().findByRole("alert")).textContent).toMatch(/already exists/);
    expect((input as HTMLInputElement).value).toBe("Argus");
    expect(main().getByTestId("bots-hire-page")).toBeTruthy();
  });

  it("groups the roles, putting one this build does not place under Other, and filters them", async () => {
    expect(groupRoles(TEMPLATES).map((group) => [group.label, group.templates.map((value) => value.id)])).toEqual([
      ["Lead", ["cto"]],
      ["Guard", ["security-auditor", "watcher"]],
      ["Other", ["mystery"]],
    ]);
    await boot(listOf(0, []));
    act(() => showHireBot());
    render(<Screen />);
    await waitFor(() => expect(main().getAllByTestId("bots-hire-role")).toHaveLength(4));
    fireEvent.change(main().getByRole("textbox", { name: "Search roles" }), { target: { value: "secur" } });
    expect(main().getAllByTestId("bots-hire-role").map((row) => row.dataset.role)).toEqual(["security-auditor"]);
  });

  it("the sidebar's + opens Hire a bot", async () => {
    await boot(listOf(1, [bot("1", "Atlas")]));
    act(() => showBotsTeam());
    render(<Screen />);
    fireEvent.click(sidebar().getByRole("button", { name: "Hire a bot" }));
    expect(await main().findByTestId("bots-hire-page")).toBeTruthy();
  });
});

describe("Bots: the team table (23.02)", () => {
  const atlas = bot("a", "Atlas");
  const iris = bot("i", "Iris", { roleTemplateId: "ux-designer", roleTitle: "UX designer", reportsTo: "a", worksIn: ["personal", "org-1"] });
  const ghost = bot("g", "Ghost", { roleTemplateId: "from-the-future", roleTitle: "Future role", reportsTo: "gone", runsOn: "cloudWorkspace", worksIn: [], paused: { at: "2026-11-20T11:00:00Z", by: "owner" } });

  it("shows each bot's role, pause state, where it runs, whom it reports to and where it works", async () => {
    await boot(listOf(4, [atlas, iris, ghost]));
    render(<Screen />);
    const rows = main().getAllByTestId("bots-table-row");
    expect(rows.map((row) => row.dataset.bot)).toEqual(["a", "i", "g"]);
    const cells = (row: HTMLElement) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim());
    expect(cells(rows[0]).slice(0, 6)).toEqual(["AtlasCTO", "Quiet", "–", "This Mac", "You", "Personal"]);
    expect(cells(rows[1]).slice(3, 6)).toEqual(["This Mac", "Atlas", "Personal, org-1"]);
    // A place and a role a newer app wrote are shown as their own text; a lead that is gone is said to be.
    expect(cells(rows[2]).slice(0, 6)).toEqual(["GhostFuture role", "Paused", "–", "cloudWorkspace", "A removed bot", "Wherever you give it work"]);
    expect(rows[2].dataset.paused).toBe("true");
    expect(within(rows[2]).getByTestId("bot-avatar-paused")).toBeTruthy();
    expect(main().getAllByTestId("bots-stat").map((card) => card.textContent)).toEqual([
      "Team3 bots2 on this Mac · 1 elsewhere",
      "Needs you0Nothing waiting",
      "Working now2 ready1 paused",
      "Spent today—Model and cloud time · shown, never capped",
    ]);
    expect(sidebar().getAllByTestId("bot-row")).toHaveLength(3);
    expect(sidebar().getByRole("button", { name: /Ghost, Future role, Paused, runs on cloudWorkspace/ })).toBeTruthy();
  });

  it("Pause all pauses every bot and then offers Resume all", async () => {
    await boot(listOf(4, [atlas, iris]));
    const pausedAt = { at: "2026-11-20T12:00:00Z", by: "owner" };
    mocks.api.pauseAll.mockResolvedValue(listOf(5, [{ ...atlas, paused: pausedAt }, { ...iris, paused: pausedAt }]));
    mocks.api.resumeAll.mockResolvedValue(listOf(6, [atlas, iris]));
    render(<Screen />);
    fireEvent.click(main().getByTestId("bots-pause-all"));
    await waitFor(() => expect(main().getByTestId("bots-all-paused")).toBeTruthy());
    expect(mocks.api.pauseAll).toHaveBeenCalledTimes(1);
    expect(main().getAllByTestId("bot-doing-now").map((cell) => cell.textContent?.trim())).toEqual(["Paused", "Paused"]);
    fireEvent.click(main().getByTestId("bots-resume-all"));
    await waitFor(() => expect(main().queryByTestId("bots-all-paused")).toBeNull());
    expect(main().getByTestId("bots-pause-all")).toBeTruthy();
  });

  it("pauses and resumes one bot from its row", async () => {
    await boot(listOf(4, [atlas]));
    mocks.api.pause.mockResolvedValue({ ...atlas, paused: { at: "2026-11-20T12:00:00Z", by: "owner" } });
    render(<Screen />);
    fireEvent.click(main().getByRole("button", { name: "Pause Atlas" }));
    await waitFor(() => expect(main().getByTestId("bots-table-row").dataset.paused).toBe("true"));
    expect(mocks.api.pause).toHaveBeenCalledWith("a");
    expect(main().getByRole("button", { name: "Resume Atlas" })).toBeTruthy();
  });
});

describe("Bots: labels", () => {
  it("reads What it does from the role's text and names an unknown access level plainly", () => {
    expect(roleDuties(TEMPLATES[0].role)).toEqual(["First thing for CTO.", "Second thing."]);
    expect(roleDuties("No headings here")).toEqual([]);
    expect(accessLabel("full")).toBe("Full access");
    expect(accessLabel("ownerOnly")).toBe("ownerOnly (acts as Read and report)");
  });
});

describe("Bots: the destination (PRO-467)", () => {
  const destinations = async () => {
    const { AppDestinations } = await import("@/components/layout/ProjectRail");
    const noop = () => {};
    render(<TooltipProvider><AppDestinations onOpenHome={noop} onNewSession={noop} onSearch={noop} onOpenIssues={noop} onOpenAgents={noop} onOpenAutomations={noop} /></TooltipProvider>);
    return screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  };

  it("lists Bots before Automations only while the switch is on", async () => {
    const labels = await destinations();
    expect(labels.indexOf("Bots")).toBeGreaterThan(-1);
    expect(labels.indexOf("Bots")).toBe(labels.indexOf("Automations") - 1);
    cleanup();
    mocks.switches = { bots: false };
    expect(await destinations()).not.toContain("Bots");
  });
});
