// @vitest-environment jsdom
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stage } from "@mobile/ui/testing/kit";
import { CloudApiError } from "../../api";
import { NewOrganization } from "./NewOrganization";
import { OrganizationChooser } from "./OrganizationChooser";

// PRO-527: board 25.02, every state it draws, with its sentences and which buttons are on.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  router: { push: vi.fn(), back: vi.fn(), dismiss: vi.fn() },
  catalog: null as any,
  snapshot: null as any,
  keys: [] as string[],
}));
vi.mock("react-native", async () => ({
  ...(await import("@mobile/ui/testing/native")),
  KeyboardAvoidingView: (await import("@mobile/ui/testing/native")).View,
  ActivityIndicator: ({ testID }: { testID?: string }) => <span data-testid={testID} role="progressbar" />,
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
}));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-router", () => ({
  Stack: { Screen: ({ options }: { options: { title: string; headerLargeTitle?: boolean } }) => <div data-testid="screen-header" data-large={String(options.headerLargeTitle)}><span data-testid="screen-title">{options.title}</span></div> },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => mocks.router,
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(() => effect(), [effect]),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true), getStringAsync: vi.fn(async () => "") }));
vi.mock("expo-crypto", () => ({ randomUUID: () => { const key = `key-${mocks.keys.length + 1}`; mocks.keys.push(key); return key; } }));
vi.mock("../../CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: () => mocks.snapshot }));

const page = stage();
const personal = { orgId: "org-personal", name: "Personal (alex@example.com)", role: "owner", isPersonal: true };
const northwind = { orgId: "org-northwind", name: "Northwind", role: "owner" };
const acme = { orgId: "org-acme", name: "Acme", role: "member" };
const boat = { id: "box", displayName: "Boat", availability: "available", canManage: true, descriptor: { credentialFields: [{ name: "credential", kind: "secret", label: "API token" }] } };

/** The signed-in account as the server lists it; `providers` answers each organization's compute. */
function account(organizations: object[], options: { creates?: boolean; providers?: (orgId: string) => unknown[] } = {}) {
  mocks.snapshot = { organizations: organizations.map((organization) => ({ organization, workspaces: [], error: null, loaded: true })), loading: false, error: null, refreshedAt: 1, saved: false, titles: {}, deletesOrganizations: false, createsOrganizations: options.creates ?? true };
  mocks.catalog = {
    api: { providers: vi.fn(async (orgId: string) => options.providers?.(orgId) ?? []), credentials: vi.fn(async () => []) },
    createOrganization: vi.fn(async (name: string) => ({ orgId: "org-new", name, role: "owner", isPersonal: false })),
  };
}

const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); });
const text = () => page.container.textContent ?? "";
const buttonNamed = (label: string) => [...page.container.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => element.textContent === label || element.getAttribute("aria-label") === label) ?? null;
const disabled = (element: Element | null) => element?.getAttribute("aria-disabled") === "true";
const field = () => page.container.querySelector("input") as HTMLInputElement;

beforeEach(() => {
  mocks.params = {};
  mocks.keys = [];
  mocks.router = { push: vi.fn(), back: vi.fn(), dismiss: vi.fn() };
});

describe("choosing the organization (25.02)", () => {
  it("a new account: the personal organization is chosen already, Create is offered, one tap carries on", async () => {
    account([personal]);
    await page.show(<OrganizationChooser />);
    await settle();
    expect(page.byId("screen-title")!.textContent).toBe("Organization");
    expect(page.byId("screen-header")!.getAttribute("data-large")).toBe("false");
    expect(text()).toContain("Cloud workspaces, the compute they run on and the agent logins they use belong to an organization.");
    const row = page.byId("organization-org-personal")!;
    expect(row.getAttribute("aria-label")).toBe("Personal (alex@example.com), Just you. A personal organization cannot have members.");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Create an organizationFor a team: invite people later and share workspaces with them.");
    await page.press(buttonNamed("Continue with the personal one"));
    expect(mocks.router.back).toHaveBeenCalled();
    // The choice is remembered for this run of the app: the next page sees it.
    await page.show(<OrganizationChooser key="again" />);
    await page.press(page.byId("create-organization"));
    expect(mocks.router.push).toHaveBeenCalledWith("/cloud/setup/new-organization?from=organization");
  });

  it("an account with several: each with the role and how far its setup is; a member's can be chosen", async () => {
    account([northwind, acme, personal], { providers: (orgId) => (orgId === "org-northwind" ? [boat] : []) });
    mocks.params = { orgId: "org-northwind" };
    await page.show(<OrganizationChooser />);
    await settle();
    expect(text()).toContain("Choose the organization to set up.");
    // The personal organization first, then the server's order.
    expect([...page.container.querySelectorAll('[role="radio"]')].map((row) => row.getAttribute("aria-label"))).toEqual([
      "Personal (alex@example.com), Personal · Owner",
      "Northwind, Owner · compute connected",
      "Acme, Member · an owner or admin sets it up",
    ]);
    expect(page.byId("organization-org-northwind")!.getAttribute("aria-selected")).toBe("true");
    expect(buttonNamed("Continue with Northwind")).not.toBeNull();
    await page.press(page.byId("organization-org-acme"));
    expect(page.byId("organization-org-acme")!.getAttribute("aria-selected")).toBe("true");
    expect(buttonNamed("Continue with Acme")).not.toBeNull();
    expect(page.byLabel("Create an organization")).not.toBeNull();
    expect(text()).not.toContain("For a team: invite people later");
  });

  it("a server without the route: no Create row, and a line on where to do it", async () => {
    account([personal], { creates: false });
    await page.show(<OrganizationChooser />);
    await settle();
    expect(page.byId("create-organization")).toBeNull();
    expect(text()).toContain("To create an organization for a team, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.");
    expect(disabled(buttonNamed("Continue with the personal one"))).toBe(false);
  });

  it("an account with no organization: only Create, or where one is made, and nothing to continue with", async () => {
    account([]);
    await page.show(<OrganizationChooser />);
    expect(page.byId("create-organization")).not.toBeNull();
    expect(buttonNamed("Continue with the personal one")).toBeNull();
    account([], { creates: false });
    await page.show(<OrganizationChooser />);
    expect(text()).toContain("To create an organization, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.");
  });
});

describe("creating an organization (25.02)", () => {
  it("empty: one field, and the button is off until the name is 2 characters", async () => {
    account([personal]);
    await page.show(<NewOrganization />);
    expect(page.byId("screen-title")!.textContent).toBe("New organization");
    expect(text()).toContain("Organization name");
    expect(text()).toContain("2 to 60 characters. You can invite people after it is set up.");
    expect(disabled(buttonNamed("Create organization"))).toBe(true);
  });

  it("named: the button is on", async () => {
    account([personal]);
    await page.show(<NewOrganization />);
    await page.type(field(), "Northwind");
    expect(disabled(buttonNamed("Create organization"))).toBe(false);
    expect(text()).not.toContain("Use 2 to 60 characters.");
  });

  it("too short or too long: checked on the phone before anything is sent", async () => {
    account([personal]);
    await page.show(<NewOrganization />);
    for (const name of ["N", "a".repeat(61)]) {
      await page.type(field(), name);
      expect(text()).toContain("Use 2 to 60 characters.");
      expect(text()).not.toContain("2 to 60 characters. You can invite");
      expect(disabled(buttonNamed("Create organization"))).toBe(true);
    }
    expect(mocks.catalog.createOrganization).not.toHaveBeenCalled();
  });

  it("creating: the field is locked and the button says so; created, back to the Cloud tab with it chosen", async () => {
    account([personal]);
    let finish: (value: unknown) => void = () => undefined;
    mocks.catalog.createOrganization = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    mocks.params = { from: "organization" };
    await page.show(<NewOrganization />);
    await page.type(field(), "  Northwind ");
    await page.press(buttonNamed("Create organization"));
    expect(mocks.catalog.createOrganization).toHaveBeenCalledWith("Northwind", "key-1");
    expect(disabled(buttonNamed("Creating…"))).toBe(true);
    expect(field().disabled).toBe(true);
    await act(async () => { finish({ orgId: "org-new", name: "Northwind", role: "owner" }); });
    // Past the organization page that opened this one.
    expect(mocks.router.dismiss).toHaveBeenCalledWith(2);
    expect(mocks.router.back).not.toHaveBeenCalled();
    // Northwind is now the one being set up, once the list the catalog read again names it.
    mocks.snapshot = { ...mocks.snapshot, organizations: [personal, { ...northwind, orgId: "org-new" }].map((organization) => ({ organization, workspaces: [], error: null, loaded: true })) };
    mocks.params = {};
    await page.show(<OrganizationChooser />);
    expect(page.byId("organization-org-new")!.getAttribute("aria-selected")).toBe("true");
  });

  it("it could not be created: the name stays, and trying again sends the same key; a new name gets its own", async () => {
    account([personal]);
    mocks.catalog.createOrganization = vi.fn(async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); });
    await page.show(<NewOrganization />);
    await page.type(field(), "Northwind");
    await page.press(buttonNamed("Create organization"));
    expect(page.byId("organization-not-created")!.textContent).toBe("The organization was not created. Check your connection and try again.");
    expect(field().value).toBe("Northwind");
    expect(disabled(buttonNamed("Create organization"))).toBe(false);
    await page.press(buttonNamed("Create organization"));
    await page.type(field(), "Northwind Labs");
    await page.press(buttonNamed("Create organization"));
    expect(mocks.catalog.createOrganization.mock.calls).toEqual([["Northwind", "key-1"], ["Northwind", "key-1"], ["Northwind Labs", "key-2"]]);
  });

  it("says a refusal in words, never its code; the server's name check is said as the phone's", async () => {
    account([personal]);
    mocks.catalog.createOrganization = vi.fn(async () => { throw new CloudApiError("organization_name_invalid", 400); });
    await page.show(<NewOrganization />);
    await page.type(field(), "Northwind");
    await page.press(buttonNamed("Create organization"));
    expect(text()).toContain("Use 2 to 60 characters.");
    mocks.catalog.createOrganization = vi.fn(async () => { throw new CloudApiError("organization_idempotency_key_reused", 409); });
    await page.type(field(), "Northwind Labs");
    await page.press(buttonNamed("Create organization"));
    expect(page.byId("organization-not-created")!.textContent).toBe("That request was already sent with other details. Start it again.");
    expect(text()).not.toContain("organization_");
  });

  it("a server without the route: says where an organization is made, and offers no form", async () => {
    account([personal], { creates: false });
    await page.show(<NewOrganization />);
    expect(text()).toContain("To create an organization for a team, use the TerminalX desktop app or the web console.");
    expect(page.container.querySelector("input")).toBeNull();
  });
});
