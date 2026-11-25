// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ComputeScreen from "../app/cloud/compute";
import ComputeProviderScreen from "../app/cloud/provider";
import { CloudApi, PROVIDER_DISCLOSURE_VERSION } from "./cloud/api";
import { stage } from "./ui/testing/kit";

// PRO-528: connect a compute provider from the phone (25.03). The screens run on the app's own
// client; only the network under it is the test's, so every request is the route the server has.
const mocks = vi.hoisted(() => ({
  params: { orgId: "org-1" } as Record<string, string>,
  push: vi.fn(),
  back: vi.fn(),
  open: vi.fn(async (_url: string) => undefined),
  clipboard: vi.fn(async () => ""),
  catalog: null as any,
  snapshot: { organizations: [] as any[] },
}));
vi.mock("react-native", async () => ({ ...(await import("@mobile/ui/testing/native")), ActivityIndicator: () => <i data-busy="true" /> }));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    Stack: { Screen: ({ options }: any) => <div data-testid="header" data-title={options.title}>{options.headerTitle?.()}</div> },
    useLocalSearchParams: () => mocks.params,
    useRouter: () => ({ push: mocks.push, back: mocks.back }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
vi.mock("expo-web-browser", () => ({ openBrowserAsync: mocks.open }));
vi.mock("expo-clipboard", () => ({ getStringAsync: mocks.clipboard }));
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => mocks.catalog, useCatalogSnapshot: () => mocks.snapshot }));
// The page's frame is the app's; here it is only what holds the page.
vi.mock("@mobile/ui/primitives", async (actual) => ({ ...(await actual<typeof import("@mobile/ui/primitives")>()), Screen: ({ children, testID }: any) => <div data-testid={testID}>{children}</div> }));

const page = stage();
const ORG = "https://login.example/v1/mobile/orgs/org-1";
const KEY = "a37_live_4f9c2d71b8e6a05c";

// The three providers as the server registers them, and one this app has never heard of.
const descriptor = (id: string, label: string, icon: string, order: number, description: string, billing: string, fields: any[] = [], more: Record<string, unknown> = {}) => ({
  id, label, icon, order, description, billing, billedByProvider: fields.length > 0, listed: true, credentialSource: fields.length ? "organization" : "platform", credentialFields: fields,
  capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: true, computeRunsUntilStopped: false },
  offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "none" },
  allowedIdleSuspendMinutes: [15], allowedRetentionDays: [7], ...more,
});
const TX = descriptor("terminalx-cloud", "TerminalX Cloud", "cloud", 1, "Machines on TerminalX Cloud. Nothing to connect: they are ready to use.", "Billed by TerminalX");
const BOAT = descriptor("box", "Boat", "ship", 2, "Fast-start sandboxes that sleep when idle. Part of the disk resets on resume.", "Per second, billed by Boat", [{ name: "credential", kind: "secret", label: "Boat API token" }]);
const A37 = descriptor("agent37", "Agent37", "server", 3, "Full virtual machines with Docker in the US, France and India. Sleeps when idle.", "Per minute from your Agent37 wallet; only disk bills while asleep", [{ name: "credential", kind: "secret", label: "Agent37 API key", helpUrl: "https://agent37.com/dashboard/cloud/api-keys" }]);
const provider = (descriptor: any, availability: string, more: Record<string, unknown> = {}) => ({ id: descriptor.id, displayName: descriptor.label, availability, canManage: true, capabilities: { releaseDisposition: "destroyed" }, descriptor, ...more });
const CONNECTED_AT = new Date(2026, 10, 20, 9, 30).getTime();
const stored = (more: Record<string, unknown> = {}) => ({ state: "connected", connectedAt: CONNECTED_AT, lastValidatedAt: CONNECTED_AT, credentialFingerprint: "sha256:9c41e07a", ...more });
const answer = (id: string, state = "connected") => ({ provider: id, state, canManage: true, ...(state === "connected" ? { credentialFingerprint: "sha256:9c41e07a", connectedAt: CONNECTED_AT, lastValidatedAt: CONNECTED_AT } : {}) });

type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }> | "offline";
interface Call { method: string; url: string; body: any }
let calls: Call[];
let routes: Record<string, (call: Call) => Reply>;
const requests = (method: string, path: string) => calls.filter((call) => call.method === method && call.url === `${ORG}${path}`);
const refuse = (error: string, status: number) => ({ status, body: { error } });

function serve(table: typeof routes) {
  routes = table;
  mocks.catalog = {
    api: new CloudApi({
      origin: "https://login.example",
      accessToken: async () => "access-token",
      fetch: (async (input: any, init: any) => {
        const call = { method: init.method, url: String(input), body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const route = routes[`${call.method} ${call.url.slice(ORG.length)}`];
        if (!route) throw new Error(`no such route: ${call.method} ${call.url}`);
        const reply = await route(call);
        if (reply === "offline") throw new TypeError("Network request failed");
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
      }) as typeof fetch,
    }),
  };
}
const listing = (...providers: any[]) => () => ({ body: { providers } });
/** An answer the test gives when it chooses to. */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = () => act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); await new Promise((done) => setTimeout(done, 0)); });
const show = async (screen: "list" | "provider", providerId?: string) => {
  mocks.params = providerId ? { orgId: "org-1", providerId } : { orgId: "org-1" };
  await page.show(screen === "list" ? <ComputeScreen /> : <ComputeProviderScreen />);
  await settle();
};
const text = () => page.container.textContent ?? "";
const keyField = (label: string) => page.container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
const consent = () => page.container.querySelector("input[role='switch']") as HTMLInputElement;
const connectButton = () => page.byId("provider-connect")!;
const off = (element: Element | null) => element?.getAttribute("aria-disabled") === "true";
const alertMock = async () => (await import("react-native")).Alert.alert as unknown as ReturnType<typeof vi.fn>;
/** Enter the key and accept the acknowledgement. */
async function fill(label: string, key = KEY) {
  await page.type(keyField(label), key);
  await page.press(consent());
}
async function connect(label: string, key = KEY) {
  await fill(label, key);
  await page.press(connectButton());
  await settle();
}

beforeEach(async () => {
  calls = [];
  mocks.push.mockReset();
  mocks.back.mockReset();
  mocks.open.mockClear();
  mocks.clipboard.mockReset().mockResolvedValue("");
  mocks.snapshot = { organizations: [{ organization: { orgId: "org-1", name: "Northwind", role: "owner" } }] };
  (await alertMock()).mockReset();
});

describe("the providers the server offers", () => {
  it("draws whatever the server lists, in the server's order, in the server's words", async () => {
    // Sent out of order, with one this app has no code for.
    const NEW = descriptor("hetzner", "Hetzner", "rocket", 4, "Dedicated machines in Germany and Finland.", "Per hour, billed by Hetzner", [{ name: "credential", kind: "secret", label: "Hetzner API token" }]);
    serve({ "GET /cloud-providers": listing(provider(NEW, "not-connected"), provider(A37, "not-connected"), provider(TX, "available"), provider(BOAT, "not-connected")) });
    await show("list");
    expect(requests("GET", "/cloud-providers")).toHaveLength(1);
    const rows = [...page.container.querySelectorAll("[data-testid^='provider-']")];
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual(["provider-terminalx-cloud", "provider-box", "provider-agent37", "provider-hetzner"]);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "TerminalX Cloud, Ready to use, Machines on TerminalX Cloud. Nothing to connect: they are ready to use., Billed by TerminalX",
      "Boat, Not connected, Fast-start sandboxes that sleep when idle. Part of the disk resets on resume., Per second, billed by Boat",
      "Agent37, Not connected, Full virtual machines with Docker in the US, France and India. Sleeps when idle., Per minute from your Agent37 wallet; only disk bills while asleep",
      "Hetzner, Not connected, Dedicated machines in Germany and Finland., Per hour, billed by Hetzner",
    ]);
    expect(text()).toContain("Cloud workspaces run on machines in a provider account. Connecting checks and stores a key; it creates no machine and spends nothing.");
    expect(page.byId("header")!.textContent).toBe("ComputeNorthwind");
    // Nothing is connected yet: no word on how many are needed.
    expect(text()).not.toContain("One provider is enough");
  });

  it("opens a provider's page for someone who manages compute, and says one is enough once one is connected", async () => {
    serve({ "GET /cloud-providers": listing(provider(TX, "available"), provider(BOAT, "available", { connection: stored() }), provider(A37, "not-connected")) });
    await show("list");
    expect(page.byId("provider-box")!.getAttribute("aria-label")).toContain("Boat, Connected");
    expect(text()).toContain("One provider is enough. A workspace picks its provider when it is launched.");
    await page.press(page.byId("provider-agent37"));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: "/cloud/provider", params: { orgId: "org-1", providerId: "agent37" } });
  });

  it("shows rows in the list's shape while the list is read", async () => {
    const pending = held<{ body: unknown }>();
    serve({ "GET /cloud-providers": () => pending.promise });
    await show("list");
    expect(page.byId("compute-reading")).not.toBeNull();
    expect(page.byLabel("Reading the providers")!.getAttribute("aria-busy")).toBe("true");
    pending.resolve({ body: { providers: [provider(A37, "not-connected")] } });
    await settle();
    expect(page.byId("compute-reading")).toBeNull();
    expect(page.byId("provider-agent37")).not.toBeNull();
  });

  it("says an empty list as such, not as an error", async () => {
    serve({ "GET /cloud-providers": listing() });
    await show("list");
    expect(text()).toBe("ComputeNorthwindNo providers are offeredYour account service offers no compute provider to this organization right now.");
    expect(page.container.querySelector("[role='button']")).toBeNull();
  });

  it("says a list that could not be read in one sentence, with one way on", async () => {
    let online = false;
    serve({ "GET /cloud-providers": () => (online ? { body: { providers: [provider(A37, "not-connected")] } } : "offline") });
    await show("list");
    expect(text()).toContain("Providers could not be read");
    expect(text()).toContain("The service could not be reached. Nothing was changed.");
    online = true;
    await page.press(page.byLabel("Try again") ?? page.byText("Try again")!.parentElement);
    await settle();
    expect(requests("GET", "/cloud-providers")).toHaveLength(2);
    expect(page.byId("provider-agent37")).not.toBeNull();
  });

  it("shows a member whether each provider can be used and who to ask, and opens nothing", async () => {
    const member = (descriptor: any, availability: string) => provider(descriptor, availability, { canManage: false });
    serve({ "GET /cloud-providers": listing(member(TX, "disabled-for-create"), member(BOAT, "available"), member(A37, "not-connected")) });
    await show("list");
    expect(page.byId("compute-owner-required")!.textContent).toBe("An organization owner or admin must connect compute. You can continue using this organization.");
    expect([...page.container.querySelectorAll("[data-testid^='provider-']")].map((row) => row.getAttribute("aria-label")!.split(", ").slice(0, 2).join(": "))).toEqual(["TerminalX Cloud: Not offered", "Boat: Available", "Agent37: Not connected"]);
    expect(page.container.querySelector("[role='button']")).toBeNull();
    expect(page.icon("ChevronRight")).toBeNull();
    await page.press(page.byId("provider-box"));
    expect(mocks.push).not.toHaveBeenCalled();
    // What a manager is told about connecting is not said to someone who cannot.
    expect(text()).not.toContain("Connecting checks and stores a key");
    expect(text()).not.toContain("One provider is enough");
  });

  it("shows a member no way to connect on a provider's own page either", async () => {
    serve({ "GET /cloud-providers": listing(provider(A37, "not-connected", { canManage: false })) });
    await show("provider", "agent37");
    expect(page.byId("compute-owner-required")).not.toBeNull();
    expect(page.container.querySelector("input")).toBeNull();
    expect(page.container.querySelector("[role='button']")).toBeNull();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("is not shown signed out", async () => {
    mocks.catalog = null;
    mocks.params = { orgId: "org-1" };
    await page.show(<ComputeScreen />);
    expect(text()).toContain("Compute unavailable");
  });
});

describe("connecting a provider", () => {
  it("builds the form from the provider's description, and keeps Connect off until the key and the acknowledgement are both there", async () => {
    serve({ "GET /cloud-providers": listing(provider(A37, "not-connected")) });
    await show("provider", "agent37");
    expect(page.byId("header")!.getAttribute("data-title")).toBe("Connect Agent37");
    expect(text()).toContain(A37.description);
    expect(text()).toContain(A37.billing);
    expect(page.icon("Server")).not.toBeNull();
    const input = keyField("Agent37 API key")!;
    expect(input.type).toBe("password");
    expect(text()).toContain("Sent once, encrypted at rest, and never shown again, here or anywhere.");
    expect(consent().getAttribute("aria-label")).toBe("I understand Agent37 bills this organization directly and every admin here can launch machines with this key.");
    expect(off(connectButton())).toBe(true);
    await page.type(input, KEY);
    expect(off(connectButton())).toBe(true);
    await page.press(consent());
    expect(off(connectButton())).toBe(false);
    await page.press(consent());
    expect(off(connectButton())).toBe(true);
    // The help link is the field's own, opened in the browser.
    await page.press(page.byLabel("Get a key"));
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("https://agent37.com/dashboard/cloud/api-keys");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("draws the same page for a provider this app has never heard of", async () => {
    const NEW = descriptor("hetzner", "Hetzner", "rocket", 4, "Dedicated machines in Germany and Finland.", "Per hour, billed by Hetzner", [{ name: "credential", kind: "passphrase", label: "Hetzner API token" }]);
    serve({ "GET /cloud-providers": listing(provider(NEW, "not-connected")), "POST /cloud-providers/hetzner/connect": () => ({ body: answer("hetzner") }) });
    await show("provider", "hetzner");
    expect(page.byId("header")!.getAttribute("data-title")).toBe("Connect Hetzner");
    // A shape the app does not have is a box; a kind of field it does not know is a secret.
    expect(page.icon("Box")).not.toBeNull();
    expect(keyField("Hetzner API token")!.type).toBe("password");
    expect(page.byLabel("Get a key")).toBeNull();
    await connect("Hetzner API token", "hcloud-key-1");
    expect(requests("POST", "/cloud-providers/hetzner/connect")[0]!.body.credential).toBe("hcloud-key-1");
  });

  it("sends the key once with the acknowledgement, empties the field as it is sent, and then shows only that a key is stored", async () => {
    const checking = held<{ body: unknown }>();
    let connected = false;
    serve({
      "GET /cloud-providers": () => ({ body: { providers: [provider(A37, connected ? "available" : "not-connected", connected ? { connection: stored() } : {})] } }),
      "POST /cloud-providers/agent37/connect": () => checking.promise,
    });
    await show("provider", "agent37");
    await fill("Agent37 API key");
    await page.press(connectButton());
    await settle();
    // While the server checks it with the provider: locked, and the key is already gone from the field.
    expect(connectButton().textContent).toBe("Checking the key…");
    expect(off(connectButton())).toBe(true);
    expect(keyField("Agent37 API key")!.value).toBe("");
    expect(keyField("Agent37 API key")!.disabled).toBe(true);
    expect(page.container.innerHTML).not.toContain(KEY);
    await page.press(connectButton());
    expect(requests("POST", "/cloud-providers/agent37/connect")).toEqual([
      expect.objectContaining({ body: { credential: KEY, disclosure: { version: PROVIDER_DISCLOSURE_VERSION, providerBillingAccepted: true, organizationUseAccepted: true } } }),
    ]);
    connected = true;
    checking.resolve({ body: answer("agent37") });
    await settle();
    expect(page.byId("provider-stored")).not.toBeNull();
    expect(page.byId("header")!.textContent).toBe("Agent37Northwind");
    expect(page.byId("provider-key")!.textContent).toBe("Keysha256:9c41e07aConnected20 Nov 2026Last checked20 Nov 2026");
    expect(text()).toContain("Connected");
    expect(page.container.innerHTML).not.toContain(KEY);
    expect(page.container.querySelector("input")).toBeNull();
  });

  it("shows the key as stored from the server's answer when the list cannot be read afterwards", async () => {
    let online = true;
    serve({
      "GET /cloud-providers": () => (online ? { body: { providers: [provider(A37, "not-connected")] } } : "offline"),
      "POST /cloud-providers/agent37/connect": () => { online = false; return { body: answer("agent37") }; },
    });
    await show("provider", "agent37");
    await connect("Agent37 API key");
    expect(page.byId("provider-stored")).not.toBeNull();
    expect(page.byId("provider-key")!.textContent).toContain("sha256:9c41e07a");
  });

  it("pastes the key from the clipboard as dots", async () => {
    mocks.clipboard.mockResolvedValue(`${KEY}\n`);
    serve({ "GET /cloud-providers": listing(provider(A37, "not-connected")), "POST /cloud-providers/agent37/connect": () => ({ body: answer("agent37") }) });
    await show("provider", "agent37");
    await page.press(page.byLabel("Paste Agent37 API key"));
    await settle();
    expect(page.container.innerHTML).not.toContain(KEY);
    await page.press(consent());
    await page.press(connectButton());
    await settle();
    expect(requests("POST", "/cloud-providers/agent37/connect")[0]!.body.credential).toBe(KEY);
  });

  it.each([
    ["a wrong key", "cloud_provider_credential_invalid", 422, "Agent37 rejected that key. Paste it again, or make a new one."],
    ["a key that lacks a permission", "cloud_provider_permission_denied", 403, "The key is valid but not allowed to do something TerminalX needs. Check the permissions of the key."],
    ["an account without billing", "cloud_provider_billing_required", 402, "Agent37 needs billing set up on that account before it will act."],
  ])("says the server's reason for %s under the field, and sends nothing again by itself", async (_what, code, status, sentence) => {
    let connected = false;
    serve({
      "GET /cloud-providers": () => ({ body: { providers: [provider(A37, connected ? "available" : "not-connected", connected ? { connection: stored() } : {})] } }),
      "POST /cloud-providers/agent37/connect": () => refuse(code, status),
    });
    await show("provider", "agent37");
    await connect("Agent37 API key", "a37_wrong_key_0000");
    const said = page.container.querySelector("[data-testid='described-field-credential'] [role='alert']")!;
    expect(said.textContent).toBe(sentence);
    expect(text()).not.toContain(code);
    expect(page.byId("provider-form-failure")).toBeNull();
    // A refused key is never kept on screen; the acknowledgement stands for the next try.
    expect(keyField("Agent37 API key")!.value).toBe("");
    expect(page.container.innerHTML).not.toContain("a37_wrong_key_0000");
    expect(off(connectButton())).toBe(true);
    expect(connectButton().textContent).toBe("Connect");
    expect(requests("POST", "/cloud-providers/agent37/connect")).toHaveLength(1);
    // The refusal says the key was not stored: the list is not asked.
    expect(requests("GET", "/cloud-providers")).toHaveLength(1);
    // Another key can be sent at once.
    routes["POST /cloud-providers/agent37/connect"] = () => { connected = true; return { body: answer("agent37") }; };
    await page.type(keyField("Agent37 API key"), KEY);
    await page.press(connectButton());
    await settle();
    expect(requests("POST", "/cloud-providers/agent37/connect").map((call) => call.body.credential)).toEqual(["a37_wrong_key_0000", KEY]);
    expect(page.byId("provider-stored")).not.toBeNull();
  });

  it("says a provider that is not answering under the form", async () => {
    serve({ "GET /cloud-providers": listing(provider(A37, "not-connected")), "POST /cloud-providers/agent37/connect": () => refuse("cloud_provider_unavailable", 503) });
    await show("provider", "agent37");
    await connect("Agent37 API key");
    expect(page.byId("provider-form-failure")!.textContent).toBe("Agent37 is not answering right now. The key was not stored. Try again in a moment.");
    expect(page.byId("provider-form-failure")!.getAttribute("role")).toBe("alert");
    expect(page.container.querySelector("[data-testid='described-field-credential'] [role='alert']")).toBeNull();
  });

  it("says a key that never left the phone was not sent", async () => {
    serve({ "GET /cloud-providers": listing(provider(A37, "not-connected")), "POST /cloud-providers/agent37/connect": () => "offline" });
    await show("provider", "agent37");
    await connect("Agent37 API key");
    expect(page.byId("provider-form-failure")!.textContent).toBe("No connection. The key was not sent. Try again when the phone is back online.");
    expect(page.icon("WifiOff")).not.toBeNull();
    expect(requests("GET", "/cloud-providers")).toHaveLength(1);
  });

  describe("when the connect got no answer that says what became of the key", () => {
    it("reads the list first, and shows the key as stored when the server stored it", async () => {
      let connected = false;
      serve({
        "GET /cloud-providers": () => ({ body: { providers: [provider(A37, connected ? "available" : "not-connected", connected ? { connection: stored() } : {})] } }),
        "POST /cloud-providers/agent37/connect": () => { connected = true; return refuse("internal_error", 500); },
      });
      await show("provider", "agent37");
      await connect("Agent37 API key");
      expect(requests("GET", "/cloud-providers")).toHaveLength(2);
      expect(page.byId("provider-stored")).not.toBeNull();
      expect(page.byId("provider-form-failure")).toBeNull();
    });

    it("says the key was not stored when the list says so", async () => {
      serve({ "GET /cloud-providers": listing(provider(A37, "not-connected")), "POST /cloud-providers/agent37/connect": () => refuse("internal_error", 500) });
      await show("provider", "agent37");
      await connect("Agent37 API key");
      expect(requests("GET", "/cloud-providers")).toHaveLength(2);
      expect(page.byId("provider-form-failure")!.textContent).toBe("The service did not answer. The key was not stored. Paste it and try again.");
      expect(text()).not.toContain("internal_error");
    });

    it("says it is not known when the list cannot be read either", async () => {
      let online = true;
      serve({
        "GET /cloud-providers": () => (online ? { body: { providers: [provider(A37, "not-connected")] } } : "offline"),
        "POST /cloud-providers/agent37/connect": () => { online = false; return refuse("internal_error", 500); },
      });
      await show("provider", "agent37");
      await connect("Agent37 API key");
      expect(page.byId("provider-form-failure")!.textContent).toBe("The service did not answer, so it is not known whether the key was stored. Open this page again when the phone is back online.");
    });
  });

  it("offers no form for a provider that asks for more than the server takes in one connect", async () => {
    const TWO = descriptor("vault", "Vault", "box", 5, "Machines behind an account id.", "Billed by Vault", [{ name: "account", kind: "text", label: "Account id" }, { name: "credential", kind: "secret", label: "Vault token" }]);
    serve({ "GET /cloud-providers": listing(provider(TWO, "not-connected")) });
    await show("provider", "vault");
    expect(page.byId("provider-several-fields")!.textContent).toBe("Vault asks for more than one value, which this app cannot send yet. Connect it from the TerminalX desktop app or the web console.");
    expect(page.container.querySelector("input")).toBeNull();
    expect(page.byId("provider-connect")).toBeNull();
  });

  it("shows a provider with nothing to connect as ready, with no form and nothing to disconnect", async () => {
    serve({ "GET /cloud-providers": listing(provider(TX, "available")) });
    await show("provider", "terminalx-cloud");
    expect(page.byId("provider-ready")!.textContent).toBe("TerminalX CloudBilled by TerminalXReady to useMachines on TerminalX Cloud. Nothing to connect: they are ready to use.");
    expect(page.container.querySelector("input")).toBeNull();
    expect(page.container.querySelector("[role='button']")).toBeNull();
  });

  it("says a provider the server no longer lists is not offered, and a list it cannot read is not read", async () => {
    serve({ "GET /cloud-providers": listing(provider(TX, "available")) });
    await show("provider", "agent37");
    expect(text()).toContain("Provider not offered");
    serve({ "GET /cloud-providers": () => "offline" });
    await act(async () => { await page.show(null); });
    await show("provider", "agent37");
    expect(text()).toContain("Providers could not be read");
    expect(page.byText("Try again")).not.toBeNull();
  });
});

describe("a provider with a key stored", () => {
  it("shows the key by its fingerprint and what to know about the provider, in the console's sentences", async () => {
    serve({ "GET /cloud-providers": listing(provider(A37, "available", { connection: stored() })) });
    await show("provider", "agent37");
    expect(page.byId("provider-key")!.textContent).toBe("Keysha256:9c41e07aConnected20 Nov 2026Last checked20 Nov 2026");
    expect(page.byText("sha256:9c41e07a")!.getAttribute("data-selectable")).toBe("true");
    expect(page.byId("provider-facts")!.textContent).toBe("You choose the machine's location.Prices shown are estimates.Provider resources are permanently destroyed when released.");
    expect(page.byId("provider-attention")).toBeNull();
    expect(page.byId("provider-replace")!.textContent).toBe("Replace key");
    expect(page.byId("provider-disconnect")!.textContent).toBe("Disconnect…");
  });

  it("says a key the server's last check rejected, and makes replacing it the main action", async () => {
    serve({ "GET /cloud-providers": listing(provider(BOAT, "attention-required", { connection: stored({ state: "attention-required" }) })) });
    await show("provider", "box");
    expect(text()).toContain("Needs attention");
    expect(page.byId("provider-attention")!.textContent).toBe("Boat rejected the stored key on its last check. Replace the key to continue. Workspaces on it cannot be started until then.");
    const replace = page.styleOf(page.byId("provider-replace"));
    const disconnect = page.styleOf(page.byId("provider-disconnect"));
    expect(replace.backgroundColor).not.toBe(disconnect.backgroundColor);
    serve({ "GET /cloud-providers": listing(provider(BOAT, "available", { connection: stored() })) });
    await act(async () => { await page.show(null); });
    await show("provider", "box");
    // At rest it is the quiet button.
    expect(page.styleOf(page.byId("provider-replace")).backgroundColor).not.toBe(replace.backgroundColor);
  });

  it("replaces the key through the connect form under another title", async () => {
    let fingerprint = "sha256:9c41e07a";
    serve({
      "GET /cloud-providers": () => ({ body: { providers: [provider(BOAT, "available", { connection: stored({ credentialFingerprint: fingerprint }) })] } }),
      "POST /cloud-providers/box/connect": () => { fingerprint = "sha256:1b7d20ff"; return { body: { ...answer("box"), credentialFingerprint: fingerprint } }; },
    });
    await show("provider", "box");
    await page.press(page.byId("provider-replace"));
    expect(page.byId("header")!.getAttribute("data-title")).toBe("Replace Boat key");
    expect(connectButton().textContent).toBe("Replace key");
    expect(off(connectButton())).toBe(true);
    await connect("Boat API token", "boat_new_token_77");
    expect(requests("POST", "/cloud-providers/box/connect")[0]!.body.credential).toBe("boat_new_token_77");
    expect(page.byId("provider-stored")).not.toBeNull();
    expect(page.byId("provider-key")!.textContent).toContain("sha256:1b7d20ff");
    expect(page.container.innerHTML).not.toContain("boat_new_token_77");
  });

  it("says the earlier key is still in use when a replacement got no answer and the list shows no change", async () => {
    serve({ "GET /cloud-providers": listing(provider(BOAT, "available", { connection: stored() })), "POST /cloud-providers/box/connect": () => refuse("internal_error", 500) });
    await show("provider", "box");
    await page.press(page.byId("provider-replace"));
    await connect("Boat API token", "boat_new_token_77");
    expect(page.byId("provider-form-failure")!.textContent).toBe("The service did not answer. The key stored before is still the one in use. Paste the new key and try again.");
  });

  it("asks before it disconnects, in the console's words, and goes back to the list once it has", async () => {
    serve({ "GET /cloud-providers": listing(provider(BOAT, "available", { connection: stored() })), "POST /cloud-providers/box/disconnect": () => ({ body: answer("box", "not-connected") }) });
    await show("provider", "box");
    const alert = await alertMock();
    await page.press(page.byId("provider-disconnect"));
    expect(requests("POST", "/cloud-providers/box/disconnect")).toHaveLength(0);
    expect(alert).toHaveBeenCalledExactlyOnceWith("Disconnect Boat?", "Existing workspaces keep running. New ones cannot be launched on Boat until a key is connected again.", [
      { text: "Cancel", style: "cancel" },
      expect.objectContaining({ text: "Disconnect", style: "destructive" }),
    ]);
    // Cancel does nothing.
    expect(alert.mock.calls[0]![2][0].onPress).toBeUndefined();
    await act(async () => { alert.mock.calls[0]![2][1].onPress(); });
    await settle();
    expect(requests("POST", "/cloud-providers/box/disconnect")).toEqual([expect.objectContaining({ body: {} })]);
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it("says what to do first when the provider still holds workspaces, and changes nothing", async () => {
    serve({ "GET /cloud-providers": listing(provider(BOAT, "available", { connection: stored() })), "POST /cloud-providers/box/disconnect": () => refuse("cloud_provider_disposition_required", 409) });
    await show("provider", "box");
    const alert = await alertMock();
    await page.press(page.byId("provider-disconnect"));
    await act(async () => { alert.mock.calls[0]![2][1].onPress(); });
    await settle();
    expect(alert).toHaveBeenLastCalledWith("Boat still holds workspaces", "Delete this organization’s workspaces on Boat first, then disconnect. Nothing was changed.", [{ text: "OK" }]);
    expect(mocks.back).not.toHaveBeenCalled();
    expect(page.byId("provider-stored")).not.toBeNull();
    expect(page.byId("provider-disconnect-failure")).toBeNull();
  });

  it("says any other refused disconnect under the page and reads the list again", async () => {
    serve({ "GET /cloud-providers": listing(provider(BOAT, "available", { connection: stored() })), "POST /cloud-providers/box/disconnect": () => "offline" });
    await show("provider", "box");
    const alert = await alertMock();
    await page.press(page.byId("provider-disconnect"));
    await act(async () => { alert.mock.calls[0]![2][1].onPress(); });
    await settle();
    expect(page.byId("provider-disconnect-failure")!.textContent).toBe("No connection. Nothing was changed. Try again when the phone is back online.");
    expect(requests("GET", "/cloud-providers")).toHaveLength(2);
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it("offers only Disconnect for a provider that is no longer offered", async () => {
    serve({ "GET /cloud-providers": listing(provider({ ...BOAT, listed: false }, "available", { connection: stored() })) });
    await show("provider", "box");
    expect(page.byId("provider-replace")).toBeNull();
    expect(page.byId("provider-disconnect")).not.toBeNull();
  });
});
