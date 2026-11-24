// @vitest-environment jsdom
import { act } from "react";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LaunchScreen from "../../../../app/cloud/launch/index";
import LaunchRepositoryScreen from "../../../../app/cloud/launch/repository";
import LaunchReviewScreen from "../../../../app/cloud/launch/review";
import { CloudApiError, type CloudCredential, type CloudProvider, type CloudProviderDescriptor, type CloudProviderSetup, type CloudQuote } from "../../api";
import { themePalette } from "../../../ui/theme";
import { stage } from "../../../ui/testing/kit";
import { holdLaunch, LaunchFlow } from "./flow";

// PRO-530: the launch pages in every state the first four rows of board 25.05
// draw, each with the board's sentences and its buttons on or off.

const mocks = vi.hoisted(() => ({
  params: { orgId: "org-northwind" } as Record<string, string>,
  push: vi.fn(),
  back: vi.fn(),
  dismissAll: vi.fn(),
  catalog: null as unknown,
  keys: 0,
}));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return { ...native, KeyboardAvoidingView: native.View, ActivityIndicator: () => <i data-icon="spinner" />, Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? <div data-testid="modal">{children as never}</div> : null) };
});
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push, back: mocks.back, dismissAll: mocks.dismissAll }),
  useFocusEffect: () => undefined,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => `launch-key-${++mocks.keys}` }));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => "" }));
vi.mock("@mobile/ui/SessionChrome", () => ({
  ScreenHeader: ({ title, subtitle, onBack }: { title: string; subtitle?: unknown; onBack(): void }) => <header><button aria-label="Back" onClick={onBack} /><h1>{title}</h1>{subtitle as never}</header>,
  HeaderLine: ({ text }: { text: string }) => <span data-testid="header-line">{text}</span>,
}));
vi.mock("@mobile/cloud/CloudProvider", () => ({
  useCloudCatalog: () => mocks.catalog,
  useCatalogSnapshot: () => ({ organizations: [{ organization: { orgId: "org-northwind", name: "Northwind", role: "admin" }, workspaces: [], error: null, loaded: true }], loading: false, error: null, refreshedAt: 1, saved: false, titles: {} }),
}));

const page = stage();
const NOW = Date.UTC(2026, 10, 24, 10, 25);
const danger = () => themePalette("Ember", "dark").danger;

// ── The server's answers, as placeholders ──
const base: Omit<CloudProviderDescriptor, "id" | "label" | "icon" | "order" | "billing" | "billedByProvider"> = { description: "", listed: true, credentialSource: "organization", credentialFields: [], capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false }, offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "provider-rate", suspendedBilling: "none" }, allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0], allowedRetentionDays: [7] };
const described = (id: string, label: string, billing: string, billedByProvider: boolean, availability = "available"): CloudProvider => ({ id, displayName: label, availability, canManage: true, descriptor: { ...base, id, label, icon: "cloud", order: 1, billing, billedByProvider } });
const BOAT = described("box", "Boat", "Per second, billed by Boat", true);
const AGENT37 = described("agent37", "Agent37", "Hourly, billed by Agent37", true);
const TX = described("terminalx-cloud", "TerminalX Cloud", "Billed by TerminalX", false);
const boatSetup: CloudProviderSetup = {
  provider: "box", credentialFingerprint: "fp", currency: "USD", pricing: "provider-rate", pricingObservedAt: NOW, sources: [],
  locations: [{ id: "auto-eu", label: "Automatic EU placement", placement: "automatic" }],
  machineClasses: [
    { id: "small", label: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, activeHourlyMicros: 18_000 },
    { id: "default", label: "Default", vcpu: 4, memoryMiB: 8192, diskGiB: 80, activeHourlyMicros: 36_000 },
    { id: "large", label: "Large", vcpu: 8, memoryMiB: 16384, diskGiB: 100, activeHourlyMicros: 72_000 },
  ],
  defaults: { sourceId: "image", locationId: "auto-eu", machineClassId: "small", idleSuspendMinutes: 15, retentionDays: 7, networkPolicy: "relay-only" },
  allowedIdleSuspendMinutes: [5, 10, 15, 30, 60, 0], allowedRetentionDays: [7], maxIdleSuspendMinutes: null,
};
const agent37Setup: CloudProviderSetup = {
  ...boatSetup, provider: "agent37",
  locations: [{ id: "us", label: "United States", placement: "selected" }, { id: "eu", label: "Europe", placement: "selected" }, { id: "asia", label: "Asia", placement: "selected" }],
  machineClasses: [{ id: "2x4", label: "2 vCPU · 4 GB RAM", vcpu: 2, memoryMiB: 4096, diskGiB: 50 }],
  defaults: { sourceId: "image", locationId: "us", machineClassId: "2x4", idleSuspendMinutes: 10, retentionDays: 7, networkPolicy: "relay-only" },
};
const login = (id: string, provider: string, more: Partial<CloudCredential> = {}): CloudCredential => ({ id, provider, authKind: "api-key", fingerprint: "f", version: 1, updatedAt: NOW, state: "connected", sharedUse: "organization", epoch: 1, ...more });
const LOGINS = [login("cred-codex", "codex", { displayIdentity: "alex@example.com", authKind: "oauth-credentials-json" }), login("cred-claude", "claude"), login("cred-github", "github")];
const quote = (micros = 18_000, expiresAt = NOW + 278_000, id = "quote-1"): CloudQuote => ({ id, provider: "box", expiresAt, currency: "USD", pricing: "provider-rate", pricingObservedAt: NOW, activeHourlyMicros: micros, alwaysOnThirtyDayMicros: micros * 720, configuration: { ...boatSetup.defaults, sourceLabel: "Image", locationLabel: "Automatic EU placement", machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, diskGiB: 40, architecture: "x86_64" } });
const launched = { workspace: { id: "ws-new", orgId: "org-northwind", name: "Checkout redesign", provider: "box", state: "provisioning" }, operation: { id: "op-1", workspaceId: "ws-new", type: "create", state: "queued", stage: null, cancelable: true, createdAt: NOW, updatedAt: NOW } };
const never = () => new Promise<never>(() => undefined);

function server(more: Partial<Record<"providers" | "credentials" | "providerSetup" | "preflight" | "quote" | "createWorkspace", (...args: never[]) => Promise<unknown>>> = {}) {
  const api = {
    serverNow: vi.fn(() => NOW),
    providers: vi.fn(more.providers ?? (async () => [BOAT])),
    credentials: vi.fn(more.credentials ?? (async () => LOGINS)),
    providerSetup: vi.fn(more.providerSetup ?? (async (_org: string, id: string) => (id === "agent37" ? agent37Setup : boatSetup))),
    preflight: vi.fn(more.preflight ?? (async () => ({ version: 1, ready: true, checks: [] }))),
    quote: vi.fn(more.quote ?? (async () => quote())),
    createWorkspace: vi.fn(more.createWorkspace ?? (async () => launched)),
  };
  mocks.catalog = { api, refresh: vi.fn(async () => undefined) };
  return api;
}

// ── Reading the page ──
const settle = () => act(async () => { for (let round = 0; round < 8; round += 1) await Promise.resolve(); });
const text = () => page.container.textContent ?? "";
const button = (label: string) => {
  const found = [...page.container.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => element.textContent === label || element.getAttribute("aria-label") === label);
  if (!found) throw new Error(`No button "${label}" in: ${text()}`);
  return found;
};
const hasButton = (label: string) => [...page.container.querySelectorAll<HTMLElement>('[role="button"]')].some((element) => element.textContent === label);
const off = (label: string) => button(label).getAttribute("aria-disabled") === "true";
const row = (id: string) => page.byId(id)!;
const valueColor = (id: string) => page.styleOf(row(id).querySelectorAll("span")[1]!).color;

async function openForm() {
  await page.show(<LaunchScreen />);
  await settle();
}
async function nameIt(name = "Checkout redesign") {
  await page.type(page.byId("launch-name")!.querySelector("input"), name);
}

/** A flow priced as the form prices it, held for the repository page and the review. */
let release: (() => void) | null = null;
async function priced(api: ReturnType<typeof server>, provider = BOAT, options: { repository?: { url: string; ref: string } } = {}) {
  const flow = new LaunchFlow({ api: api as never, orgId: "org-northwind", newKey: () => `launch-key-${++mocks.keys}` });
  release = holdLaunch(flow);
  flow.edit({ name: "Checkout redesign", providerId: provider.id, selection: boatSetup.defaults, agents: ["cred-codex"], repository: options.repository ?? { url: "github.com/acme/app", ref: "main" } });
  await flow.price({ provider, setup: { ...boatSetup, provider: provider.id }, credentials: LOGINS, organizationName: "Northwind" });
  return flow;
}
const spend = () => vi.mocked(Alert.alert).mock.calls.at(-1)!;
const pressInAlert = async (label: string) => { await act(async () => { spend()[2]!.find((entry) => entry.text === label)!.onPress!(); }); await settle(); };

beforeEach(() => {
  mocks.params = { orgId: "org-northwind" };
  mocks.keys = 0;
  mocks.push.mockReset(); mocks.back.mockReset(); mocks.dismissAll.mockReset();
  vi.mocked(Alert.alert).mockReset();
});
afterEach(() => { release?.(); release = null; });

describe("Set it up", () => {
  it("01 the form, on Boat: the provider's defaults chosen, Region a fact, Provider hidden with one to launch on", async () => {
    server();
    await openForm();
    expect(page.byId("header-line")?.textContent).toBe("Northwind");
    expect(row("launch-size").getAttribute("aria-label")).toBe("Size: Small · $0.018 / hour");
    expect(row("launch-region").getAttribute("role")).toBeNull();
    expect(row("launch-region").textContent).toBe("RegionAutomatic EU placement");
    expect(row("launch-idle").getAttribute("aria-label")).toBe("Stop when idle: After 15 minutes");
    expect(page.byId("launch-provider")).toBeNull();
    expect(page.byId("launch-login-codex")?.getAttribute("aria-label")).toBe("Codex, alex@example.com");
    expect(page.byId("launch-login-claude")?.textContent).toContain("API key");
    expect(page.byId("launch-login-github")).toBeNull();
    expect(text()).toContain("Every member of this organization can use this workspace and steer its sessions.");
    expect(text()).not.toContain("Private");
    expect(off("Review price")).toBe(true);
    await nameIt();
    expect(off("Review price")).toBe(false);
  });

  it("02 on Agent37: Provider shows with more than one to launch on, and Region is a picker of the server's places", async () => {
    server({ providers: async () => [AGENT37, BOAT] });
    await openForm();
    expect(row("launch-provider").getAttribute("aria-label")).toBe("Provider: Agent37");
    expect(row("launch-size").getAttribute("aria-label")).toBe("Size: 2 vCPU · 4 GB RAM");
    expect(row("launch-region").getAttribute("aria-label")).toBe("Region: United States");
    expect(row("launch-idle").getAttribute("aria-label")).toBe("Stop when idle: After 10 minutes");
    await page.press(row("launch-region"));
    expect(page.byId("launch-region-sheet")?.textContent).toBe("RegionUnited StatesEuropeAsia");
    await page.press(page.byId("launch-region-sheet-eu"));
    expect(row("launch-region").getAttribute("aria-label")).toBe("Region: Europe");
    await page.press(row("launch-provider"));
    await page.press(page.byId("launch-provider-sheet-box"));
    await settle();
    expect(row("launch-size").getAttribute("aria-label")).toBe("Size: Small · $0.018 / hour");
  });

  it("03 Size: the server's machine classes with their hourly rate, in a sheet", async () => {
    server();
    await openForm();
    await page.press(row("launch-size"));
    const sheet = page.byId("launch-size-sheet")!;
    expect(sheet.textContent).toContain("Boat · prices are estimates, in US dollars");
    expect(page.byId("launch-size-sheet-small")?.getAttribute("aria-label")).toBe("Small, 2 vCPU · 4 GiB memory · 40 GiB disk, $0.018 per active hour");
    expect(page.byId("launch-size-sheet-large")?.getAttribute("aria-label")).toBe("Large, 8 vCPU · 16 GiB memory · 100 GiB disk, $0.072 per active hour");
    expect(page.byId("launch-size-sheet-small")?.getAttribute("aria-selected")).toBe("true");
    await page.press(page.byId("launch-size-sheet-default"));
    expect(page.byId("launch-size-sheet")).toBeNull();
    expect(row("launch-size").getAttribute("aria-label")).toBe("Size: Default · $0.036 / hour");
  });

  it("04 Stop when idle: the server's allowed times, Never last, and how a stopped workspace behaves", async () => {
    server();
    await openForm();
    await page.press(row("launch-idle"));
    const sheet = page.byId("launch-idle-sheet")!;
    expect(sheet.textContent).toBe("Stop when idle5 minutes10 minutes15 minutes30 minutes60 minutesNever: always onA stopped workspace starts again when you send it a message.");
    expect(page.byId("launch-idle-sheet-15")?.getAttribute("aria-selected")).toBe("true");
    await page.press(page.byId("launch-idle-sheet-0"));
    expect(row("launch-idle").getAttribute("aria-label")).toBe("Stop when idle: Never");
  });

  it("05 Repository, empty: optional, typed or pasted; Use this repository only for a GitHub repository", async () => {
    const api = server();
    const flow = new LaunchFlow({ api: api as never, orgId: "org-northwind", newKey: () => "k" });
    release = holdLaunch(flow);
    await page.show(<LaunchRepositoryScreen />);
    expect(text()).toContain("Optional. The repository is cloned before the workspace becomes available.");
    expect(text()).toContain("A private repository is cloned with the GitHub token saved in Agent logins.");
    expect(page.byId("launch-repository-url")?.querySelector("input")?.getAttribute("placeholder")).toBe("github.com/owner/repository");
    expect(off("Use this repository")).toBe(true);
    expect(hasButton("Launch without a repository")).toBe(false);
    await page.type(page.byId("launch-repository-url")!.querySelector("input"), "github.com/acme");
    expect(off("Use this repository")).toBe(true);
    await page.type(page.byId("launch-repository-url")!.querySelector("input"), "github.com/acme/app");
    await page.type(page.byId("launch-repository-ref")!.querySelector("input"), "main");
    expect(off("Use this repository")).toBe(false);
    await page.press(button("Use this repository"));
    expect(flow.getSnapshot().draft.repository).toEqual({ url: "github.com/acme/app", ref: "main" });
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("06 Checking and pricing: the preflight and the quote together, the form held", async () => {
    const api = server({ preflight: never });
    await openForm();
    await nameIt();
    await page.press(button("Review price"));
    expect(off("Checking and pricing…")).toBe(true);
    expect(api.preflight).toHaveBeenCalledWith("org-northwind", { credentialIds: ["cred-codex"] });
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("goes on to the review once the server checked and priced it", async () => {
    const api = server();
    await openForm();
    await nameIt();
    await page.press(button("Review price"));
    await settle();
    expect(api.quote).toHaveBeenCalledWith("org-northwind", { provider: "box", ...boatSetup.defaults });
    expect(mocks.push).toHaveBeenCalledWith("/cloud/launch/review?orgId=org-northwind");
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });
});

describe("Before there is anything to set up", () => {
  it("07 reading what the provider offers", async () => {
    server({ providers: never });
    await openForm();
    expect(text()).toContain("Reading sizes and prices…");
    server({ providerSetup: never });
    await page.show(<></>);
    await openForm();
    expect(text()).toContain("Reading sizes and prices…From Boat, for Northwind.");
  });

  it("08 compute is not connected: Connect compute goes to the compute page", async () => {
    server({ providers: async () => [described("box", "Boat", "", true, "not-connected")] });
    await openForm();
    expect(text()).toContain("Connect compute firstNorthwind has no provider to launch on yet.");
    expect(off("Connect compute")).toBe(false);
    await page.press(button("Connect compute"));
    expect(mocks.push).toHaveBeenCalledWith("/cloud/compute?orgId=org-northwind");
  });

  it("08 compute is not connected, as the setup read says it", async () => {
    server({ providerSetup: async () => { throw new CloudApiError("cloud_provider_connection_required", 409); } });
    await openForm();
    expect(text()).toContain("Connect compute first");
  });

  it("09 launching is paused (cloud_provisioning_paused, cloud_provider_creation_disabled)", async () => {
    server({ providers: async () => [described("box", "Boat", "", true, "disabled-for-create")] });
    await openForm();
    expect(text()).toContain("New workspaces are pausedNew cloud workspaces are paused for this organization.");
    expect(hasButton("Review price")).toBe(false);
    for (const code of ["cloud_provisioning_paused", "cloud_provider_creation_disabled"]) {
      server({ providerSetup: async () => { throw new CloudApiError(code, 403); } });
      await page.show(<></>);
      await openForm();
      expect(text()).toContain("New workspaces are paused");
    }
  });

  it("10 no network: nothing was launched, and Try again reads again", async () => {
    const api = server({ providers: async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "network"); } });
    await openForm();
    expect(text()).toContain("Sizes and prices could not be readThe service could not be reached. Nothing was launched.");
    api.providers.mockResolvedValueOnce([BOAT]);
    await page.press(button("Try again"));
    await settle();
    expect(page.byId("launch-size")).not.toBeNull();
  });

  it("says a refusal it has no sentence for in the generic one, never the code", async () => {
    server({ providers: async () => { throw new CloudApiError("cloud_something_new", 400); } });
    await openForm();
    expect(text()).toContain("Sizes and prices could not be readThat did not work. Try again in a moment.");
    expect(text()).not.toContain("cloud_something_new");
  });
});

describe("Preflight problems", () => {
  const twoProblems = async () => ({ version: 1, ready: false, checks: [
    { kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed", errorCode: "cloud_workspace_repository_credential_required" },
    { kind: "credential", provider: "codex", credentialId: "cred-codex", status: "failed", errorCode: "cloud_agent_credential_reauth_required" },
  ] });

  it("11 two things to fix: listed at the top in the board's sentences, each marking its field, and Review price off", async () => {
    const api = server({ preflight: twoProblems });
    // The form, with the repository page over it as the stack keeps them: the page sets the repository on the form's flow.
    await page.show(<><LaunchScreen /><LaunchRepositoryScreen /></>);
    await settle();
    await nameIt();
    await page.type(page.byId("launch-repository-url")!.querySelector("input"), "https://github.com/acme/app");
    await page.press(button("Use this repository"));
    expect(row("launch-repository").getAttribute("aria-label")).toBe("Repository: github.com/acme/app");
    expect(valueColor("launch-repository")).not.toBe(danger());
    await page.press(button("Review price"));
    await settle();
    expect(page.byId("launch-problems")?.textContent).toBe("Two things to fix before this can be pricedacme/app: this repository needs a GitHub personal access token.Codex: sign-in required.");
    expect(off("Review price")).toBe(true);
    expect(api.quote).not.toHaveBeenCalled();
    expect(valueColor("launch-repository")).toBe(danger());
    expect(page.styleOf(page.byId("launch-login-codex")!.querySelectorAll("span")[1]!).color).toBe(danger());
    expect(page.styleOf(page.byId("launch-login-claude")!.querySelectorAll("span")[1]!).color).not.toBe(danger());
  });

  it("12 a private repository: the sentence under the URL, and the way to a GitHub token in Agent logins", async () => {
    const api = server({ preflight: async () => ({ version: 1, ready: false, checks: [{ kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed", errorCode: "cloud_workspace_repository_credential_required" }] }) });
    const flow = await priced(api, BOAT, { repository: { url: "https://github.com/acme/app", ref: "main" } });
    expect(flow.getSnapshot().check.state).toBe("problems");
    await page.show(<LaunchRepositoryScreen />);
    await settle();
    expect(page.byId("launch-repository-url")?.textContent).toContain("This repository needs a GitHub personal access token.");
    expect(page.byId("launch-add-github-token")?.getAttribute("aria-label")).toBe("Add a GitHub token, Saved for Northwind, in Agent logins");
    expect(text()).not.toContain("A private repository is cloned with the GitHub token saved in Agent logins.");
    expect(off("Use this repository")).toBe(false);
    expect(off("Launch without a repository")).toBe(false);
    await page.press(page.byId("launch-add-github-token"));
    expect(mocks.push).toHaveBeenCalledWith("/cloud/logins/github?orgId=org-northwind");
  });

  it("13 a branch that is not there: the sentence under the branch, and launching without a repository", async () => {
    const api = server({ preflight: async () => ({ version: 1, ready: false, checks: [{ kind: "repository", cloneUrl: "https://github.com/acme/app.git", status: "failed", errorCode: "cloud_workspace_repository_ref_not_found" }] }) });
    const flow = await priced(api, BOAT, { repository: { url: "https://github.com/acme/app", ref: "release/2.14" } });
    await page.show(<LaunchRepositoryScreen />);
    await settle();
    expect(page.byId("launch-repository-ref")?.textContent).toContain("That branch or tag was not found in the repository.");
    expect(page.byId("launch-repository-url")?.textContent).not.toContain("not found");
    expect(text()).toContain("A private repository is cloned with the GitHub token saved in Agent logins.");
    expect(page.byId("launch-add-github-token")).toBeNull();
    await page.press(button("Launch without a repository"));
    expect(flow.getSnapshot().draft.repository).toBeNull();
    expect(flow.getSnapshot().check.state).toBe("idle");
    expect(mocks.back).toHaveBeenCalled();
  });
});

describe("Review, and the spend confirmation", () => {
  it("14 review: the configuration, then the quote's price, the provider's billing line and the countdown", async () => {
    const api = server();
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    expect(page.byId("launch-review-facts")?.textContent).toBe("NameCheckout redesignProviderBoatSizeSmall · 2 vCPU · 4 GiB · 40 GiBRegionAutomatic EU placementStops when idleAfter 15 minutesRepositoryacme/app · mainAgentsCodex");
    expect(page.byId("price")?.textContent).toContain("Per active hour$0.018Always on, 30 days$12.96");
    expect(page.byId("price-holds")?.textContent).toBe("Per second, billed by Boat. Prices are estimates, in US dollars. This price holds for 4:38.");
    expect(off("Launch workspace")).toBe(false);
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it("15 confirm the spend: Launch workspace only asks, and only the confirmation's Launch creates it", async () => {
    const api = server();
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await page.press(button("Launch workspace"));
    expect(api.createWorkspace).not.toHaveBeenCalled();
    const [title, sentence, buttons] = spend();
    expect(title).toBe("Launch and start spending?");
    expect(sentence).toBe("Boat bills this workspace to Northwind directly, not TerminalX: about $0.018 for each hour it is active.");
    expect(buttons!.map((entry) => [entry.text, entry.style])).toEqual([["Cancel", "cancel"], ["Launch", undefined]]);
    expect(buttons![0]!.onPress).toBeUndefined();
    expect(api.createWorkspace).not.toHaveBeenCalled();
    await pressInAlert("Launch");
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
    expect(api.createWorkspace).toHaveBeenCalledWith("org-northwind", { name: "Checkout redesign", quoteId: "quote-1", confirmProviderSpend: true, setup: { repositories: [{ cloneUrl: "https://github.com/acme/app.git", ref: "main" }], credentialIds: ["cred-github", "cred-codex"] } }, "launch-key-1");
    expect(mocks.dismissAll).toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/cloud/ws-new?orgId=org-northwind");
  });

  it("16 on TerminalX Cloud: TerminalX's own sentence, from the descriptor", async () => {
    const api = server();
    await priced(api, TX);
    await page.show(<LaunchReviewScreen />);
    expect(page.byId("price-holds")?.textContent).toBe("Billed by TerminalX. Prices are estimates, in US dollars. This price holds for 4:38.");
    await page.press(button("Launch workspace"));
    expect(spend()[1]).toBe("TerminalX bills this workspace to Northwind: about $0.018 for each hour it is active.");
  });

  it("17 launching: the request is on its way, and the button is off", async () => {
    const api = server({ createWorkspace: never });
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await page.press(button("Launch workspace"));
    await pressInAlert("Launch");
    expect(off("Launching…")).toBe(true);
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("retries a launch that timed out with the same idempotency key, through the confirmation again", async () => {
    const api = server({ createWorkspace: async () => { throw new CloudApiError("cloud_workspace_unavailable", null, "timeout"); } });
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await page.press(button("Launch workspace"));
    await pressInAlert("Launch");
    expect(page.byId("launch-error")?.textContent).toBe("The service could not be reached. Try again in a moment.");
    api.createWorkspace.mockResolvedValueOnce(launched);
    await page.press(button("Launch workspace"));
    await pressInAlert("Launch");
    expect(api.createWorkspace.mock.calls.map((call) => (call as unknown[])[2])).toEqual(["launch-key-1", "launch-key-1"]);
    expect(mocks.push).toHaveBeenCalledWith("/cloud/ws-new?orgId=org-northwind");
  });

  it("18 the price expired: the old figures dimmed, nothing launched, and only a new price goes on", async () => {
    const api = server({ quote: async () => quote(18_000, NOW - 1) });
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await settle();
    expect(page.byId("launch-expired")?.textContent).toBe("That estimate expired. Nothing was launched. Get a new price to carry on.");
    expect(page.byId("price-holds")).toBeNull();
    expect(page.styleOf(page.byId("price")!.querySelector('[aria-label^="Per active hour"]')).opacity).toBe(0.45);
    expect(hasButton("Launch workspace")).toBe(false);
    expect(off("Get a new price")).toBe(false);
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it("18 the server says the quote expired at launch: the same page, and no second try at the old price", async () => {
    const api = server({ createWorkspace: async () => { throw new CloudApiError("cloud_workspace_quote_expired", 409); } });
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await page.press(button("Launch workspace"));
    await pressInAlert("Launch");
    expect(page.byId("launch-expired")?.textContent).toBe("That estimate expired. Nothing was launched. Get a new price to carry on.");
    expect(hasButton("Launch workspace")).toBe(false);
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("19 the new price is different: it says what it was, and Launch asks again at the new rate with a new key", async () => {
    const api = server({ quote: async () => quote(18_000, NOW - 1) });
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await settle();
    api.quote.mockResolvedValueOnce(quote(20_000, NOW + 300_000, "quote-2"));
    await page.press(button("Get a new price"));
    await settle();
    expect(page.byId("launch-price-changed")?.textContent).toBe("The price changed since you last looked: it was $0.018 per active hour.");
    expect(page.byId("price")?.textContent).toContain("Per active hour$0.020Always on, 30 days$14.40");
    expect(off("Launch workspace")).toBe(false);
    await page.press(button("Launch workspace"));
    expect(spend()[1]).toBe("Boat bills this workspace to Northwind directly, not TerminalX: about $0.020 for each hour it is active.");
    await pressInAlert("Launch");
    expect(api.createWorkspace).toHaveBeenCalledWith("org-northwind", expect.objectContaining({ quoteId: "quote-2", confirmProviderSpend: true }), "launch-key-1");
  });

  it("never launches from a confirmation left open until the price ran out", async () => {
    let clock = NOW;
    const api = server();
    api.serverNow.mockImplementation(() => clock);
    await priced(api);
    await page.show(<LaunchReviewScreen />);
    await page.press(button("Launch workspace"));
    clock = NOW + 278_000;
    await pressInAlert("Launch");
    expect(api.createWorkspace).not.toHaveBeenCalled();
    expect(page.byId("launch-expired")).not.toBeNull();
  });
});
