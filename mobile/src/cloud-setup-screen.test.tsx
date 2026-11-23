// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CloudScreen from "../app/(tabs)/cloud";
import SetupStepsScreen from "../app/cloud/setup/index";
import NewOrganizationScreen, { resetCreationForTests } from "../app/cloud/setup/new-organization";
import SetupOrganizationScreen from "../app/cloud/setup/organization";
import { CloudApiError } from "./cloud/api";
import { chooseSetupOrganization, resetSetupChoiceForTests } from "./cloud/setup-choice";
import { appearance, stage } from "./ui/testing/kit";
import { themePalette } from "./ui/theme";

// PRO-527: first-run setup on the Cloud tab (25.01) and choosing or creating an organization (25.02).

const mocks = vi.hoisted(() => ({
  app: {} as any,
  catalog: null as any,
  push: vi.fn(), back: vi.fn(), dismiss: vi.fn(),
  // The pages the router has: all of the setup's, unless a test takes some away.
  pages: [] as string[],
  focus: [] as (() => void | (() => void))[],
  kept: new Map<string, string>(),
  uuid: 0,
}));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    Stack: { Screen: ({ options }: { options: { title: string } }) => <div data-testid="screen-title">{options.title}</div> },
    useRouter: () => ({ push: mocks.push, back: mocks.back, dismiss: mocks.dismiss }),
    useSitemap: () => ({ contextKey: "", filename: "", href: "/", isInternal: false, isGenerated: false, children: mocks.pages.map((href: string) => ({ contextKey: `.${href}.tsx`, filename: href, href, isInternal: false, isGenerated: false, children: [] })) }),
    // In view when drawn; `mocks.focus` holds the latest, to come back to the screen with.
    useFocusEffect: (run: () => void | (() => void)) => { mocks.focus.push(run); useEffect(() => run(), [run]); },
  };
});
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(), getStringAsync: vi.fn(async () => "") }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `key-${++mocks.uuid}` }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (name: string) => mocks.kept.get(name) ?? null,
  setItem: async (name: string, value: string) => { mocks.kept.set(name, value); },
  removeItem: async (name: string) => { mocks.kept.delete(name); },
} }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: (catalog: any) => catalog?.getSnapshot() ?? { organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {} } }));
vi.mock("@mobile/state/mac-pins", () => ({ useMacPins: () => ({ cloudActions: () => [] }) }));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return {
    ...native,
    RefreshControl: () => null,
    KeyboardAvoidingView: native.View,
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    Settings: { get: () => undefined },
    SectionList: ({ sections, renderItem, renderSectionHeader, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: any) => <div>{ListHeaderComponent}{sections.length ? sections.map((section: any) => <div key={section.key} data-testid="cloud-section">{renderSectionHeader({ section })}{section.data.map((item: any, index: number) => <div key={item.workspace.id}>{renderItem({ item, index, section })}</div>)}</div>) : ListEmptyComponent}{ListFooterComponent}</div>,
  };
});

const page = stage();
const text = () => page.container.textContent ?? "";
const step = (key: string) => page.byId(`setup-step-${key}`)!;
const said = (key: string) => step(key).getAttribute("aria-label");
const button = (label: string) => [...page.container.querySelectorAll<HTMLElement>('[role="button"]')].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label) ?? null;
const off = (element: Element | null) => element?.getAttribute("aria-disabled") === "true";
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const show = async (node: React.ReactNode) => { await page.show(node); await settle(); await settle(); };

const USER = "u-alex";
const personal = { orgId: "org-p", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
const northwind = { orgId: "org-n", name: "Northwind", role: "owner" };
const acme = { orgId: "org-a", name: "Acme", role: "member" };
const workspace = (id: string, orgId: string, fields: Record<string, unknown> = {}) => ({ workspace: { id, orgId, name: id, provider: "box", state: "ready", you: { role: "manager", canApprove: true }, ...fields }, latestOperation: null });
const entry = (organization: Record<string, unknown>, workspaces: unknown[] = [], error: string | null = null) => ({ organization, workspaces, error, loaded: true });
const provider = (displayName: string, fields: { availability?: string; state?: string | null; source?: string } = {}) => ({
  id: displayName.toLowerCase(), displayName, availability: fields.availability ?? "available", canManage: true,
  ...(fields.state === null ? {} : { connection: { state: fields.state ?? "connected", connectedAt: 1 } }),
  descriptor: { label: displayName, credentialSource: fields.source ?? "organization" },
});
const offered = (displayName: string) => provider(displayName, { availability: "not-connected", state: null });
const login = (name: string, state = "connected") => ({ id: `c-${name}`, provider: name, state });

/** The account as the service lists it: organizations, and each one's providers and agent logins. */
function account(organizations: ReturnType<typeof entry>[], options: { error?: string | null; saved?: boolean; creates?: boolean; providers?: Record<string, unknown[] | Error>; logins?: Record<string, unknown[] | Error> } = {}) {
  const snapshot = { organizations, loading: false, error: options.error ?? null, refreshedAt: 1, saved: options.saved ?? false, titles: {}, deletesOrganizations: false };
  const answer = (table: Record<string, unknown[] | Error> | undefined) => vi.fn(async (orgId: string) => { const found = table?.[orgId] ?? []; if (found instanceof Error) throw found; return found; });
  mocks.catalog = {
    getSnapshot: () => snapshot,
    refresh: vi.fn(async () => undefined),
    watch: vi.fn(() => () => undefined),
    api: { providers: answer(options.providers), credentials: answer(options.logins), createsOrganizations: () => options.creates ?? true, createOrganization: vi.fn(async (name: string) => ({ orgId: "org-new", name, role: "owner", isPersonal: false })) },
  };
  return mocks.catalog;
}
const choose = (orgId: string) => chooseSetupOrganization(USER, orgId);

beforeEach(() => {
  mocks.app = { ready: true, session: { user: { userId: USER } }, signIn: vi.fn() };
  mocks.catalog = null;
  mocks.pages = ["/cloud/setup", "/cloud/setup/organization", "/cloud/setup/new-organization", "/cloud/compute", "/agent-logins", "/cloud/new"];
  mocks.push.mockReset(); mocks.back.mockReset(); mocks.dismiss.mockReset();
  mocks.focus.length = 0;
  mocks.kept.clear();
  mocks.uuid = 0;
  resetSetupChoiceForTests();
  resetCreationForTests();
});

describe("the Cloud tab with nothing set up (25.01)", () => {
  it("says what a cloud workspace is and offers the first step, with the organization the account already has", async () => {
    const catalog = account([entry(personal)]);
    await show(<CloudScreen />);
    expect(text()).toContain("A cloud workspace is a machine where your agents keep working while your phone is in your pocket. Four steps set one up.");
    expect(said("organization")).toBe("Step 1 of 4, next: Organization. Workspaces belong to an organization. Yours is Personal (alex@example.com).");
    expect(said("compute")).toBe("Step 2 of 4, not started: Connect compute. The provider account your workspaces run on.");
    expect(said("agents")).toBe("Step 3 of 4, not started: Sign your agents in. What Codex, Claude Code and Cursor sign in with there.");
    expect(said("launch")).toBe("Step 4 of 4, not started: Launch a workspace. Pick a size, see the price, start working.");
    // Only the step to do opens; the others wait, with no chevron.
    expect(step("organization").getAttribute("role")).toBe("button");
    expect(step("compute").getAttribute("role")).toBeNull();
    expect(page.container.querySelectorAll('[data-icon="ChevronRight"]')).toHaveLength(1);
    // The old empty page is gone, and so is its folded row for the one organization.
    expect(text()).not.toContain("No cloud workspaces you can see.");
    expect(text()).not.toContain("with no workspaces");
    // Nothing of an organization nobody chose is read.
    expect(catalog.api.providers).not.toHaveBeenCalled();
    await page.press(button("Start setup"));
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup/organization");
    await page.press(step("organization"));
    expect(mocks.push).toHaveBeenCalledTimes(2);
  });

  it("draws the step to do next in the accent of the theme, dark and light", async () => {
    for (const scheme of ["dark", "light"] as const) {
      appearance.scheme = scheme;
      account([entry(personal)]);
      await show(<CloudScreen key={scheme} />);
      const palette = themePalette(scheme === "light" ? "Den" : "Ember", scheme);
      const marks = [...page.container.querySelectorAll('[data-testid="setup-step-mark"]')].map((mark) => page.styleOf(mark).backgroundColor);
      expect(marks).toEqual([palette.accent, palette.raised, palette.raised, palette.raised]);
      expect(page.styleOf(button("Start setup")).backgroundColor).toBe(palette.accent);
    }
  });

  it("comes back half-way to the step that was left, read from the server", async () => {
    choose("org-p");
    const catalog = account([entry(personal)], { providers: { "org-p": [provider("Boat"), offered("Agent37")] } });
    await show(<CloudScreen />);
    expect(catalog.api.providers).toHaveBeenCalledWith("org-p");
    expect(catalog.api.credentials).toHaveBeenCalledWith("org-p");
    expect(text()).not.toContain("Four steps set one up.");
    expect(text()).toContain("Personal (alex@example.com)");
    expect(said("organization")).toBe("Step 1 of 4, done: Organization. Personal (alex@example.com)");
    expect(said("compute")).toBe("Step 2 of 4, done: Connect compute. Boat · connected");
    expect(said("agents")).toBe("Step 3 of 4, next: Sign your agents in. What Codex, Claude Code and Cursor sign in with there.");
    expect(said("launch")).toContain("not started");
    // Finished steps stay open to change; the one that waits does not.
    expect(step("compute").getAttribute("role")).toBe("button");
    expect(step("launch").getAttribute("role")).toBeNull();
    await page.press(button("Continue: sign your agents in"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/agent-logins", params: { orgId: "org-p" } });
    await page.press(step("compute"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-p" } });
    await page.press(step("organization"));
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup/organization");
  });

  it("reads the steps again on coming back from a step's page", async () => {
    choose("org-p");
    const answers: unknown[][] = [[offered("Boat")], [provider("Boat")]];
    const catalog = account([entry(personal)]);
    catalog.api.providers = vi.fn(async () => answers.shift() ?? [provider("Boat")]);
    await show(<CloudScreen />);
    expect(button("Continue: connect compute")).not.toBeNull();
    await act(async () => { mocks.focus.at(-1)!(); });
    await settle();
    expect(said("compute")).toBe("Step 2 of 4, done: Connect compute. Boat · connected");
    expect(button("Continue: sign your agents in")).not.toBeNull();
  });

  it("offers the launch once compute and an agent are in", async () => {
    choose("org-p");
    account([entry(personal)], { providers: { "org-p": [provider("Boat")] }, logins: { "org-p": [login("codex")] } });
    await show(<CloudScreen />);
    expect(said("agents")).toBe("Step 3 of 4, done: Sign your agents in. Codex · connected");
    expect(said("launch")).toBe("Step 4 of 4, next: Launch a workspace. Pick a size, see the price, start working.");
    const launch = button("Launch a workspace")!;
    expect(launch.querySelector('[data-icon="Plus"]')).not.toBeNull();
    await page.press(launch);
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/new", params: { orgId: "org-p" } });
    await page.press(step("launch"));
    expect(mocks.push).toHaveBeenCalledTimes(2);
    // The title's + is the launch screen's own (PRO-530): this page adds none.
    expect(page.byId("launch-workspace")).toBeNull();
  });

  it("does not offer a step whose page is not in the app, and offers it once it is", async () => {
    // Compute, agent logins and launching are other issues' screens: a path with no page would open as a workspace of that name.
    mocks.pages = ["/cloud/setup", "/cloud/setup/organization", "/cloud/setup/new-organization"];
    choose("org-p");
    account([entry(personal)]);
    await show(<CloudScreen />);
    expect(said("compute")).toContain("next");
    expect(step("organization").getAttribute("role")).toBe("button");
    expect(step("compute").getAttribute("role")).toBeNull();
    expect(page.container.querySelectorAll('[role="button"]')).toHaveLength(1);
    expect(text()).not.toContain("Continue: connect compute");
    mocks.pages = [...mocks.pages, "/cloud/compute"];
    await show(<CloudScreen key="with-compute" />);
    await page.press(button("Continue: connect compute"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-p" } });
  });

  it("does not take compute TerminalX holds the key for as connected compute", async () => {
    choose("org-p");
    account([entry(personal)], { providers: { "org-p": [provider("TerminalX Cloud", { source: "platform" }), offered("Boat")] }, logins: { "org-p": [login("codex")] } });
    await show(<CloudScreen />);
    expect(said("compute")).toContain("next");
    expect(text()).not.toContain("TerminalX Cloud");
    expect(said("launch")).toContain("not started");
    expect(button("Continue: connect compute")).not.toBeNull();
  });

  it("folds the organization being set up to one row once others have workspaces", async () => {
    choose("org-p");
    account([entry(northwind, [workspace("checkout", "org-n")]), entry(personal), entry({ orgId: "org-e", name: "Empty", role: "owner" })], { providers: { "org-p": [provider("Boat")] } });
    await show(<CloudScreen />);
    expect(page.container.querySelectorAll('[data-testid="cloud-section"]')).toHaveLength(1);
    expect(page.byId("setup-card")).toBeNull();
    const folded = page.byId("setup-folded")!;
    expect(folded.getAttribute("aria-label")).toBe("Set up cloud workspaces, 2 of 4 steps done");
    // Under its own name, after the organizations that have workspaces, and not counted among the empty ones.
    expect(text().indexOf("Personal (alex@example.com)")).toBeGreaterThan(text().indexOf("checkout"));
    expect(text()).toContain("1 organization with no workspaces");
    await page.press(folded);
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup");
  });

  it("shows only the list, as before, when the chosen organization has workspaces", async () => {
    choose("org-n");
    const catalog = account([entry(northwind, [workspace("checkout", "org-n")])]);
    await show(<CloudScreen />);
    expect(page.byId("setup-card")).toBeNull();
    expect(page.byId("setup-folded")).toBeNull();
    expect(catalog.api.providers).not.toHaveBeenCalled();
  });

  it("tells a member who can connect compute, and shows their own organization's steps under it", async () => {
    choose("org-a");
    const catalog = account([entry(acme), entry(personal)], { providers: { "org-a": [offered("Boat")], "org-p": [offered("Boat")] }, logins: { "org-a": new CloudApiError("organization_admin_required", 403) } });
    await show(<CloudScreen />);
    expect(text()).toContain("Acme has no compute yet");
    expect(text()).toContain("An organization owner or admin must connect compute. You can launch a workspace once they have.");
    expect(catalog.api.providers).toHaveBeenCalledWith("org-p");
    // Their own organization's steps, with no second button: the rows open the steps.
    const own = page.byId("setup-card-own")!;
    expect(own.textContent).toContain("Connect compute");
    expect(said("compute")).toBe("Step 2 of 4, next: Connect compute. The provider account your workspaces run on.");
    expect(page.container.querySelectorAll('[role="button"]').length).toBe(2);
    expect(button("Continue: connect compute")).toBeNull();
    await page.press(step("compute"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-p" } });
  });

  it("lets a member launch once an admin connected compute, with no way into compute or the logins", async () => {
    choose("org-a");
    account([entry(acme), entry(personal)], { providers: { "org-a": [provider("Boat")] }, logins: { "org-a": new CloudApiError("organization_admin_required", 403) } });
    await show(<CloudScreen />);
    expect(text()).not.toContain("has no compute yet");
    expect(page.byId("setup-card-own")).toBeNull();
    expect(step("compute").getAttribute("role")).toBeNull();
    expect(step("agents").getAttribute("role")).toBeNull();
    await page.press(button("Launch a workspace"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/new", params: { orgId: "org-a" } });
  });

  it("turns compute red when the provider rejected the stored key, and the button goes to the key", async () => {
    choose("org-p");
    account([entry(personal)], { providers: { "org-p": [provider("Boat", { availability: "attention-required", state: "attention-required" })] }, logins: { "org-p": [login("codex")] } });
    await show(<CloudScreen />);
    expect(said("compute")).toBe("Step 2 of 4, needs attention: Connect compute. Boat rejected the stored key on its last check.");
    expect(page.styleOf(page.byText("Boat rejected the stored key on its last check.")).color).toBe(themePalette("Ember", "dark").danger);
    expect(step("compute").querySelector('[data-icon="TriangleAlert"]')).not.toBeNull();
    expect(said("launch")).toBe("Step 4 of 4, not started: Launch a workspace. Waits for compute.");
    await page.press(button("Fix the provider key"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/cloud/compute", params: { orgId: "org-p" } });
  });

  it("keeps what was read and turns the button off while the service cannot be reached", async () => {
    choose("org-p");
    const catalog = account([entry(personal)], { providers: { "org-p": [provider("Boat")] } });
    await show(<CloudScreen />);
    // The network goes: the list keeps its answer and says so, and the steps keep theirs.
    catalog.getSnapshot().error = "cloud_workspace_unavailable";
    catalog.api.providers = vi.fn(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
    catalog.api.credentials = vi.fn(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
    await act(async () => { mocks.focus.at(-1)!(); });
    await settle();
    expect(page.container.querySelector('[role="alert"]')!.textContent).toBe("The service could not be reached. What is shown may be out of date.");
    expect(said("compute")).toBe("Step 2 of 4, done: Connect compute. Boat · connected");
    const next = button("Continue: sign your agents in");
    expect(off(next)).toBe(true);
    await page.press(next);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(text()).toContain("Setup carries on when the phone is back online. Nothing you finished is lost.");
  });

  it("shows a step whose list did not answer as unread, with no button and no guess", async () => {
    choose("org-p");
    account([entry(personal)], { providers: { "org-p": new CloudApiError("cloud_workspace_invalid_response", 200) }, logins: { "org-p": new CloudApiError("cloud_workspace_invalid_response", 200) } });
    await show(<CloudScreen />);
    expect(said("organization")).toContain("done");
    expect(said("compute")).toBe("Step 2 of 4, needs attention: Connect compute. Could not be read. Pull down to try again.");
    expect(said("agents")).toBe("Step 3 of 4, needs attention: Sign your agents in. Could not be read. Pull down to try again.");
    expect(said("launch")).toContain("not started");
    expect(step("compute").getAttribute("role")).toBeNull();
    expect(page.byId("setup-card")!.querySelectorAll('[role="button"]')).toHaveLength(1);
    expect(text()).toContain("Pull down to read it again.");
  });

  it("uses a choice only for the account that made it, and drops it when someone else signs in", async () => {
    choose("org-p");
    mocks.app = { ready: true, session: { user: { userId: "u-other" } }, signIn: vi.fn() };
    const catalog = account([entry(personal)]);
    await show(<CloudScreen />);
    expect(text()).toContain("Four steps set one up.");
    expect(catalog.api.providers).not.toHaveBeenCalled();
    expect(mocks.kept.size).toBe(0);
  });

  it("goes back to the first step when the chosen organization is no longer on the account", async () => {
    choose("org-gone");
    account([entry(personal)]);
    await show(<CloudScreen />);
    expect(said("organization")).toContain("next");
    expect(button("Start setup")).not.toBeNull();
  });

  it("starts an account the service lists no organization for at the same step, and shows nothing while the list cannot be read", async () => {
    account([]);
    await show(<CloudScreen />);
    expect(text()).not.toContain("No organizations");
    expect(said("organization")).toBe("Step 1 of 4, next: Organization. Workspaces belong to an organization.");
    await page.press(button("Start setup"));
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup/organization");
    // The list did not answer and none is kept: the warning, and no steps on a guess.
    account([], { error: "cloud_workspace_unavailable" });
    await show(<CloudScreen key="unread" />);
    expect(page.container.querySelector('[role="alert"]')!.textContent).toBe("The service could not be reached. What is shown may be out of date.");
    expect(page.byId("setup-card")).toBeNull();
  });

  it("asks a signed-out person to sign in, as before", async () => {
    mocks.app = { ready: true, session: null, signIn: vi.fn() };
    await show(<CloudScreen />);
    expect(text()).toContain("Sign in for cloud workspaces");
    expect(page.byId("setup-card")).toBeNull();
  });
});

describe("the steps on their own page", () => {
  it("shows the chosen organization's steps, read when the page opens", async () => {
    choose("org-p");
    const catalog = account([entry(northwind, [workspace("checkout", "org-n")]), entry(personal)], { providers: { "org-p": [provider("Boat")] } });
    await show(<SetupStepsScreen />);
    expect(page.byId("screen-title")!.textContent).toBe("Set up cloud workspaces");
    expect(catalog.api.providers).toHaveBeenCalledWith("org-p");
    expect(text()).toContain("PERSONAL (ALEX@EXAMPLE.COM)");
    expect(said("compute")).toContain("Boat · connected");
    await page.press(button("Continue: sign your agents in"));
    expect(mocks.push).toHaveBeenLastCalledWith({ pathname: "/agent-logins", params: { orgId: "org-p" } });
  });

  it("says so when no organization is being set up", async () => {
    account([entry(personal)]);
    await show(<SetupStepsScreen />);
    expect(text()).toContain("No organization is being set up");
  });
});

describe("choosing the organization (25.02)", () => {
  it("has a new account's personal organization chosen already, and offers creating one for a team", async () => {
    account([entry(personal)]);
    await show(<SetupOrganizationScreen />);
    expect(page.byId("screen-title")!.textContent).toBe("Organization");
    expect(text()).toContain("Cloud workspaces, the compute they run on and the agent logins they use belong to an organization.");
    const row = page.byId("organization-org-p")!;
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.getAttribute("data-hint")).toBe("Just you. A personal organization cannot have members.");
    expect(page.styleOf(row).backgroundColor).toBe(themePalette("Ember", "dark").selected);
    expect(row.querySelector('[data-icon="Check"]')).not.toBeNull();
    expect(page.byId("create-organization")!.textContent).toBe("Create an organizationFor a team: invite people later and share workspaces with them.");
    await page.press(page.byId("create-organization"));
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup/new-organization");
    // One tap carries on: the phone keeps the choice, and nothing is sent.
    await page.press(button("Continue with the personal one"));
    expect(JSON.parse([...mocks.kept.values()][0]!)).toEqual({ userId: USER, orgId: "org-p" });
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("lists several with the role and how far each is, and carries on with the one picked", async () => {
    const catalog = account([entry(personal), entry(northwind), entry(acme)], { providers: { "org-n": [provider("Boat")], "org-p": [offered("Boat")] } });
    await show(<SetupOrganizationScreen />);
    expect(text()).toContain("Choose the organization to set up.");
    expect(page.byId("organization-org-p")!.getAttribute("data-hint")).toBe("Personal · Owner");
    expect(page.byId("organization-org-n")!.getAttribute("data-hint")).toBe("Owner · compute connected");
    expect(page.byId("organization-org-a")!.getAttribute("data-hint")).toBe("Member · an owner or admin sets it up");
    // A member's organization is not asked for its providers on this page.
    expect(catalog.api.providers.mock.calls.map(([orgId]: [string]) => orgId).sort()).toEqual(["org-n", "org-p"]);
    expect(button("Continue with the personal one")).not.toBeNull();
    await page.press(page.byId("organization-org-n"));
    expect(page.byId("organization-org-n")!.getAttribute("aria-selected")).toBe("true");
    expect(page.byId("organization-org-p")!.getAttribute("aria-selected")).toBeNull();
    // Creating sits apart from the list, as one row.
    expect(page.byId("create-organization")!.textContent).toBe("Create an organization");
    await page.press(button("Continue with Northwind"));
    expect(JSON.parse([...mocks.kept.values()][0]!)).toEqual({ userId: USER, orgId: "org-n" });
  });

  it("starts on the organization chosen before", async () => {
    choose("org-n");
    account([entry(personal), entry(northwind)]);
    await show(<SetupOrganizationScreen />);
    expect(page.byId("organization-org-n")!.getAttribute("aria-selected")).toBe("true");
  });

  it("offers only the personal one against a server that does not take creation from a phone, and says where a team's is made", async () => {
    account([entry(personal)], { creates: false });
    await show(<SetupOrganizationScreen />);
    expect(page.byId("create-organization")).toBeNull();
    expect(text()).toContain("To create an organization for a team, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.");
    expect(button("Continue with the personal one")).not.toBeNull();
  });

  it("claims nothing about creation from a list kept from before", async () => {
    account([entry(personal)], { saved: true });
    await show(<SetupOrganizationScreen />);
    expect(page.byId("create-organization")).toBeNull();
    expect(text()).not.toContain("does not take it from the phone");
  });

  it("asks a signed-out person to sign in", async () => {
    mocks.app = { ready: true, session: null };
    await show(<SetupOrganizationScreen />);
    expect(text()).toContain("Sign in to see your organizations.");
  });

  it("gives an account with no organization the way to create one, or says where one is made", async () => {
    account([]);
    await show(<SetupOrganizationScreen />);
    expect(page.byId("create-organization")).not.toBeNull();
    expect(text()).not.toContain("Continue with");
    await page.press(button("Create an organization"));
    expect(mocks.push).toHaveBeenLastCalledWith("/cloud/setup/new-organization");
    account([], { creates: false });
    await show(<SetupOrganizationScreen key="older" />);
    expect(page.byId("create-organization")).toBeNull();
    expect(text()).toContain("use the TerminalX desktop app or the web console");
    expect(page.container.querySelectorAll('[role="button"]')).toHaveLength(0);
  });
});

describe("creating an organization (25.02)", () => {
  const field = () => page.container.querySelector("input") as HTMLInputElement;
  const create = () => button("Create organization");

  it("is one field, with the button off until the name is long enough", async () => {
    account([entry(personal)]);
    await show(<NewOrganizationScreen />);
    expect(page.byId("screen-title")!.textContent).toBe("New organization");
    expect(field().placeholder).toBe("Organization name");
    expect(field().getAttribute("aria-label")).toBe("Organization name");
    expect(text()).toContain("2 to 60 characters. You can invite people after it is set up.");
    expect(off(create())).toBe(true);
    await page.type(field(), "N");
    expect(page.container.querySelector('[role="alert"]')!.textContent).toBe("Use 2 to 60 characters.");
    expect(text()).not.toContain("You can invite people");
    expect(off(create())).toBe(true);
    await page.type(field(), "x".repeat(61));
    expect(off(create())).toBe(true);
    await page.type(field(), "  Northwind ");
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
    expect(off(create())).toBe(false);
    await page.press(create());
    expect(mocks.catalog.api.createOrganization).toHaveBeenCalledExactlyOnceWith("Northwind", "key-1");
  });

  it("creates it, makes it the organization being set up, reads the list again and goes back to the steps", async () => {
    const catalog = account([entry(personal)]);
    await show(<NewOrganizationScreen />);
    await page.type(field(), "Northwind");
    await page.press(create());
    await settle();
    expect(JSON.parse([...mocks.kept.values()][0]!)).toEqual({ userId: USER, orgId: "org-new" });
    expect(catalog.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("creates on Return too, locks the field while it is sent, and sends once", async () => {
    const catalog = account([entry(personal)]);
    let answer!: (value: unknown) => void;
    catalog.api.createOrganization = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    await show(<NewOrganizationScreen />);
    await page.type(field(), "Northwind");
    await act(async () => { field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(field().disabled).toBe(true);
    const busy = button("Creating…")!;
    expect(off(busy)).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    await page.press(busy);
    expect(catalog.api.createOrganization).toHaveBeenCalledTimes(1);
    await act(async () => { answer({ orgId: "org-new", name: "Northwind", role: "owner" }); });
    await settle();
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the name when it could not be created, and tries again with the same key", async () => {
    const catalog = account([entry(personal)]);
    catalog.api.createOrganization = vi.fn()
      .mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null, "timeout"))
      .mockResolvedValueOnce({ orgId: "org-new", name: "Northwind", role: "owner" });
    await show(<NewOrganizationScreen />);
    await page.type(field(), "Northwind");
    await page.press(create());
    await settle();
    expect(page.byId("creation-failed")!.textContent).toBe("The organization was not created. Check your connection and try again.");
    expect(field().value).toBe("Northwind");
    expect(mocks.kept.size).toBe(0);
    expect(mocks.dismiss).not.toHaveBeenCalled();
    await page.press(create());
    await settle();
    // The request that may have arrived is the one sent again: never a second Northwind.
    expect(catalog.api.createOrganization.mock.calls).toEqual([["Northwind", "key-1"], ["Northwind", "key-1"]]);
    expect(page.byId("creation-failed")).toBeNull();
    expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps that key for the same name after leaving the page, and takes a new one for another name", async () => {
    const catalog = account([entry(personal)]);
    catalog.api.createOrganization = vi.fn(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
    await show(<NewOrganizationScreen key="first" />);
    await page.type(field(), "Northwind");
    await page.press(create());
    await settle();
    await show(<NewOrganizationScreen key="again" />);
    await page.type(field(), "Northwind");
    await page.press(create());
    await settle();
    await page.type(field(), "Northwind Labs");
    expect(page.byId("creation-failed")).toBeNull();
    await page.press(create());
    await settle();
    expect(catalog.api.createOrganization.mock.calls).toEqual([["Northwind", "key-1"], ["Northwind", "key-1"], ["Northwind Labs", "key-2"]]);
  });

  it("takes a new key after the server said no, shows its refusal of the name on the field, and asks for sign-in when signed out", async () => {
    const catalog = account([entry(personal)]);
    catalog.api.createOrganization = vi.fn()
      .mockRejectedValueOnce(new CloudApiError("organization_name_invalid", 400))
      .mockRejectedValueOnce(new CloudApiError("unauthorized", 401))
      .mockRejectedValueOnce(new CloudApiError("organization_idempotency_result_unavailable", 409));
    await show(<NewOrganizationScreen />);
    await page.type(field(), "Northwind");
    await page.press(create());
    await settle();
    expect(page.container.querySelector('[role="alert"]')!.textContent).toBe("Use 2 to 60 characters.");
    expect(page.byId("creation-failed")).toBeNull();
    await page.type(field(), "Northwind");
    await page.press(create());
    await settle();
    expect(page.byId("creation-failed")!.textContent).toBe("Sign in again to create an organization.");
    await page.press(create());
    await settle();
    // A code with no sentence of its own is never shown as it is.
    expect(page.byId("creation-failed")!.textContent).toBe("That did not work. Try again in a moment.");
    expect(catalog.api.createOrganization.mock.calls.map(([, key]: [string, string]) => key)).toEqual(["key-1", "key-2", "key-3"]);
  });

  it("still makes the new organization the one being set up when the page was left before the answer", async () => {
    const catalog = account([entry(personal)]);
    let answer!: (value: unknown) => void;
    catalog.api.createOrganization = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    await show(<NewOrganizationScreen />);
    await page.type(field(), "Northwind");
    await page.press(create());
    await show(<div />);
    await act(async () => { answer({ orgId: "org-new", name: "Northwind", role: "owner" }); });
    await settle();
    expect(JSON.parse([...mocks.kept.values()][0]!)).toEqual({ userId: USER, orgId: "org-new" });
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
