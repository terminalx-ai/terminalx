// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Alert } from "react-native";
import ComputeScreen from "../../../../app/cloud/compute";
import ComputeProviderScreen from "../../../../app/cloud/compute/[providerId]";
import { CloudApiError, type CloudProvider, type CloudProviderConnection } from "@mobile/cloud/api";
import { stage } from "@mobile/ui/testing/kit";

// Board 25.03 (PRO-528): every state it draws, with its sentences and which buttons are on.
const mocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  push: vi.fn(),
  back: vi.fn(),
  paste: vi.fn(async () => ""),
  browse: vi.fn(async () => ({})),
  api: null as null | { providers: ReturnType<typeof vi.fn>; connectProvider: ReturnType<typeof vi.fn>; disconnectProvider: ReturnType<typeof vi.fn> },
}));
vi.mock("expo-router", () => ({
  // The header as the stack draws it: the screen's own title view where it gives one.
  Stack: { Screen: ({ options }: { options: { title: string; headerTitle?: () => ReactNode } }) => <div data-testid="screen-header" data-title={options.title}>{options.headerTitle ? options.headerTitle() : options.title}</div> },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
  useFocusEffect: () => undefined,
}));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return { ...native, KeyboardAvoidingView: native.View, ActivityIndicator: () => <span role="progressbar" /> };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
vi.mock("@mobile/ui/tab-bar-inset", () => ({ useTabBarInset: () => 0 }));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-clipboard", () => ({ getStringAsync: mocks.paste }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: mocks.browse }));
vi.mock("@mobile/cloud/CloudProvider", () => ({
  useCloudCatalog: () => (mocks.api ? { api: mocks.api } : null),
  useCatalogSnapshot: () => ({ organizations: [{ organization: { orgId: "org-1", name: "Northwind", role: "admin" }, workspaces: [] }], loading: false, error: null, refreshedAt: 1, saved: false, titles: {} }),
}));

const page = stage();
const KEY = "a37_live_4f1d0c2b9e7a";
const DAY = 24 * 60 * 60_000;

// Placeholder descriptors in the server's shape: the app learns names, fields and lines only from a list like this.
const descriptor = (id: string, label: string, fields: CloudProvider["descriptor"]["credentialFields"], extra: Partial<CloudProvider["descriptor"]> = {}): CloudProvider["descriptor"] => ({
  id, label, icon: id === "terminalx-cloud" ? "cloud" : id === "box" ? "ship" : "server", order: 1,
  description: `${label} machines, as the server describes them.`, billing: `Billed by ${label}`, billedByProvider: true, listed: true,
  credentialSource: fields.length ? "organization" : "platform", credentialFields: fields,
  capabilities: { pauseResumeWithMemory: false, stopStart: true, snapshots: false, exec: false, computeRunsUntilStopped: false },
  offering: { locations: "required", sources: "none", machineClasses: "catalog", pricingSource: "estimate", suspendedBilling: "none" },
  allowedIdleSuspendMinutes: [15], allowedRetentionDays: [7], ...extra,
});
const secret = (label: string, helpUrl?: string) => [{ name: "credential", kind: "secret" as const, label, ...(helpUrl ? { helpUrl } : {}) }];
const cloud = (over: Partial<CloudProvider> = {}): CloudProvider => ({ id: "terminalx-cloud", displayName: "TerminalX Cloud", availability: "available", canManage: true, descriptor: descriptor("terminalx-cloud", "TerminalX Cloud", []), ...over });
const boat = (over: Partial<CloudProvider> = {}): CloudProvider => ({ id: "box", displayName: "Boat", availability: "not-connected", canManage: true, descriptor: descriptor("box", "Boat", secret("Boat API token")), ...over });
const agent37 = (over: Partial<CloudProvider> = {}): CloudProvider => ({ id: "agent37", displayName: "Agent37", availability: "not-connected", canManage: true, descriptor: descriptor("agent37", "Agent37", secret("Agent37 API key", "https://agent37.example/keys")), ...over });
const connection = (connectedAt: number, lastValidatedAt: number, state: "connected" | "attention-required" = "connected") => ({ state, connectedAt, lastValidatedAt, credentialFingerprint: "sha256:9c41e07a" });
const answer = (provider: string): CloudProviderConnection => ({ provider, state: "connected", canManage: true, credentialFingerprint: "sha256:1b7f22c0", connectedAt: Date.now(), lastValidatedAt: Date.now() });

function serve(providers: CloudProvider[] | (() => Promise<CloudProvider[]>)) {
  mocks.api = {
    providers: vi.fn(typeof providers === "function" ? providers : async () => providers),
    connectProvider: vi.fn(async (_org: string, id: string) => answer(id)),
    disconnectProvider: vi.fn(async (_org: string, id: string) => ({ provider: id, state: "not-connected", canManage: true })),
  };
  return mocks.api;
}

const text = () => page.container.textContent ?? "";
const title = () => page.byId("screen-header")!.textContent;
const buttonNamed = (label: string) => [...page.container.querySelectorAll<HTMLElement>("[role='button']")].find((element) => element.getAttribute("aria-label") === label || element.textContent === label) ?? null;
const isOff = (element: HTMLElement | null) => element?.getAttribute("aria-disabled") === "true";
const keyInput = (name = "credential") => page.byId(`described-field-${name}`)!.querySelector("input") as HTMLInputElement | null;
const consent = () => page.byId("connect-consent")!.querySelector("input[role='switch']") as HTMLInputElement;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function showList(providers: CloudProvider[] | (() => Promise<CloudProvider[]>)) {
  serve(providers);
  mocks.params = { orgId: "org-1" };
  await page.show(<ComputeScreen />);
  await settle();
}
async function showProvider(providers: CloudProvider[], providerId: string, replace = false) {
  const api = serve(providers);
  mocks.params = { orgId: "org-1", providerId, ...(replace ? { replace: "1" } : {}) };
  await page.show(<ComputeProviderScreen />);
  await settle();
  return api;
}
/** Paste the key and turn the acknowledgement on, as 25.03's "Key pasted, acknowledged". */
async function pasteAndAccept(label = "Agent37 API key") {
  mocks.paste.mockResolvedValue(KEY);
  await page.press(page.byLabel(`Paste ${label}`));
  await settle();
  await act(async () => { consent().click(); });
}

const logged: unknown[][] = [];
beforeEach(() => {
  mocks.push.mockReset(); mocks.back.mockReset(); mocks.browse.mockClear();
  mocks.paste.mockReset().mockResolvedValue("");
  vi.mocked(Alert.alert).mockReset();
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
});
afterEach(() => {
  // The key reaches no log, whatever a test did.
  expect(JSON.stringify(logged)).not.toContain(KEY);
  vi.restoreAllMocks();
});

describe("the providers the server offers", () => {
  it("01 nothing connected yet: the server's providers in its order, each opening its page", async () => {
    await showList([cloud(), boat(), agent37()]);
    expect(title()).toBe("ComputeNorthwind");
    expect(text()).toContain("Cloud workspaces run on machines in a provider account. Connecting checks and stores a key; it creates no machine and spends nothing.");
    const rows = ["terminalx-cloud", "box", "agent37"].map((id) => page.byId(`compute-provider-${id}`)!);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "TerminalX Cloud, Ready to use, TerminalX Cloud machines, as the server describes them., Billed by TerminalX Cloud",
      "Boat, Not connected, Boat machines, as the server describes them., Billed by Boat",
      "Agent37, Not connected, Agent37 machines, as the server describes them., Billed by Agent37",
    ]);
    expect(rows.every((row) => row.getAttribute("role") === "button")).toBe(true);
    expect(text()).not.toContain("One provider is enough");
    await page.press(rows[2]);
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/cloud/compute/agent37?orgId=org-1");
  });

  it("02 one connected: its badge, and that one is enough", async () => {
    await showList([cloud(), boat({ availability: "available", connection: connection(Date.now() - DAY, Date.now()) }), agent37()]);
    expect(page.byId("compute-provider-box")!.getAttribute("aria-label")).toContain("Boat, Connected");
    expect(text()).toContain("One provider is enough. A workspace picks its provider when it is launched.");
  });

  it("03 reading: the intro over rows in the list's shape", async () => {
    await showList(() => new Promise(() => undefined));
    expect(text()).toContain("Cloud workspaces run on machines in a provider account.");
    expect(page.byLabel("Reading compute providers")!.getAttribute("role")).toBe("progressbar");
    expect(page.byId("compute-list")).toBeNull();
  });

  it("04 none offered: an empty list is said as such, not as an error", async () => {
    await showList([]);
    expect(text()).toContain("No providers are offered");
    expect(text()).toContain("Your account service offers no compute provider to this organization right now.");
    expect(buttonNamed("Try again")).toBeNull();
  });

  it("05 could not be read: one sentence and one way on", async () => {
    let fail = true;
    await showList(async () => { if (fail) throw new CloudApiError("cloud_workspace_unavailable", null, "network"); return [cloud()]; });
    expect(text()).toContain("Providers could not be read");
    expect(text()).toContain("The service could not be reached. Nothing was changed.");
    const retry = buttonNamed("Try again")!;
    expect(isOff(retry)).toBe(false);
    fail = false;
    await page.press(retry);
    await settle();
    expect(mocks.api!.providers).toHaveBeenCalledTimes(2);
    expect(page.byId("compute-provider-terminalx-cloud")).not.toBeNull();
  });

  it("05 a refusal that is not the network is said in plain words, never as its code", async () => {
    await showList(async () => { throw new CloudApiError("cloud_something_new", 409); });
    expect(text()).toContain("That did not work. Try again in a moment.");
    expect(text()).not.toContain("cloud_something_new");
  });

  it("06 a member's view: who can connect, whether each can be used, and no row opens", async () => {
    await showList([cloud({ availability: "disabled-for-create", canManage: false }), boat({ availability: "available", canManage: false }), agent37({ canManage: false })]);
    expect(text()).toContain("An organization owner or admin must connect compute. You can continue using this organization.");
    expect(text()).not.toContain("Connecting checks and stores a key");
    const rows = ["terminalx-cloud", "box", "agent37"].map((id) => page.byId(`compute-provider-${id}`)!);
    expect(rows.map((row) => row.getAttribute("aria-label")!.split(", ")[1])).toEqual(["Not offered", "Available", "Not connected"]);
    expect(rows.some((row) => row.getAttribute("role") === "button")).toBe(false);
  });
});

describe("connect: the path that works", () => {
  it("07 empty: the descriptor's form, with Connect off", async () => {
    await showProvider([cloud(), boat(), agent37()], "agent37");
    expect(page.byId("screen-header")!.dataset.title).toBe("Connect Agent37");
    expect(text()).toContain("Agent37 machines, as the server describes them.");
    expect(text()).toContain("Billed by Agent37");
    expect(keyInput()!.getAttribute("aria-label")).toBe("Agent37 API key");
    expect(keyInput()!.type).toBe("password");
    expect(text()).toContain("Sent once, encrypted at rest, and never shown again, here or anywhere.");
    expect(consent().getAttribute("aria-label")).toBe("I understand Agent37 bills this organization directly and every admin here can launch machines with this key.");
    expect(consent().checked).toBe(false);
    expect(isOff(buttonNamed("Connect"))).toBe(true);
    // "Get a key" opens the field's own address in the browser.
    await page.press(page.container.querySelector("[role='link']"));
    expect(mocks.browse).toHaveBeenCalledExactlyOnceWith("https://agent37.example/keys");
  });

  it("08 key pasted, acknowledged: dots only, and Connect on", async () => {
    await showProvider([agent37()], "agent37");
    mocks.paste.mockResolvedValue(KEY);
    await page.press(page.byLabel("Paste Agent37 API key"));
    await settle();
    expect(isOff(buttonNamed("Connect"))).toBe(true);
    await act(async () => { consent().click(); });
    expect(isOff(buttonNamed("Connect"))).toBe(false);
    expect(text()).toContain("•".repeat(24));
    expect(page.container.innerHTML).not.toContain(KEY);
  });

  it("09 checking: the key is sent once with both acknowledgements, and the form is locked", async () => {
    const api = await showProvider([agent37()], "agent37");
    api.connectProvider.mockImplementation(() => new Promise(() => undefined));
    await pasteAndAccept();
    await page.press(buttonNamed("Connect"));
    expect(api.connectProvider).toHaveBeenCalledExactlyOnceWith("org-1", "agent37", KEY, { providerBilling: true, organizationUse: true });
    const button = buttonNamed("Checking the key…")!;
    expect(isOff(button)).toBe(true);
    expect(consent().disabled).toBe(true);
    expect(page.container.innerHTML).not.toContain(KEY);
  });

  it("10 connected: the key by fingerprint, the descriptor's facts, Replace key and Disconnect", async () => {
    const api = await showProvider([agent37()], "agent37");
    api.providers.mockResolvedValue([agent37({ availability: "available", connection: { ...connection(Date.UTC(2026, 10, 23, 12), Date.now()), credentialFingerprint: "sha256:1b7f22c0" } })]);
    await pasteAndAccept();
    await page.press(buttonNamed("Connect"));
    await settle();
    expect(page.byId("provider-connected")).not.toBeNull();
    expect(title()).toBe("Agent37Northwind");
    expect(page.byId("provider-key-facts")!.textContent).toMatch(/^Keysha256:1b7f22c0Connected23 Nov 2026Last checkedtoday, \d\d:\d\d$/);
    expect(text()).toContain("The key itself is never shown again. The line above is a fingerprint, to tell one key from another.");
    expect(page.byId("provider-facts")!.textContent).toBe("You choose the machine’s location.Prices shown are estimates.");
    expect(isOff(buttonNamed("Replace key"))).toBe(false);
    expect(isOff(buttonNamed("Disconnect…"))).toBe(false);
    expect(page.container.innerHTML).not.toContain(KEY);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("11 TerminalX Cloud: no fields, so no form and nothing to disconnect", async () => {
    await showProvider([cloud(), boat()], "terminalx-cloud");
    expect(title()).toBe("TerminalX CloudNorthwind");
    expect(text()).toContain("Ready to use");
    expect(text()).toContain("TerminalX Cloud machines, as the server describes them.");
    expect(page.container.querySelector("input")).toBeNull();
    expect(page.container.querySelectorAll("[role='button']")).toHaveLength(0);
  });

  it("12 any provider the server describes: one input per field, text visible, secret hidden", async () => {
    const odd = { id: "lattice", displayName: "Lattice", availability: "not-connected", canManage: true, descriptor: descriptor("lattice", "Lattice", [{ name: "accountId", kind: "text", label: "Account ID" }, { name: "token", kind: "secret", label: "API token", helpUrl: "https://lattice.example/tokens" }], { icon: "lattice" }) } satisfies CloudProvider;
    const api = await showProvider([odd], "lattice");
    expect(page.byId("screen-header")!.dataset.title).toBe("Connect Lattice");
    expect(keyInput("accountId")!.type).toBe("text");
    expect(keyInput("token")!.type).toBe("password");
    expect(page.container.querySelectorAll("[role='link']")).toHaveLength(1);
    expect(consent().getAttribute("aria-label")).toBe("I understand Lattice bills this organization directly and every admin here can launch machines with this key.");
    // The phone's route sends one value: a form of two is said, not half-sent.
    await page.type(keyInput("accountId"), "acct_81");
    await pasteAndAccept("API token");
    expect(text()).toContain("This provider asks for more than one value");
    expect(isOff(buttonNamed("Connect"))).toBe(true);
    await page.press(buttonNamed("Connect"));
    expect(api.connectProvider).not.toHaveBeenCalled();
  });
});

describe("connect: when it does not work", () => {
  async function refuse(error: CloudApiError) {
    const api = await showProvider([agent37()], "agent37");
    api.connectProvider.mockRejectedValue(error);
    await pasteAndAccept();
    await page.press(buttonNamed("Connect"));
    await settle();
    return api;
  }
  const fieldLine = () => page.byId("described-field-credential")!.textContent;

  it("13 the provider rejected the key: said under the field, which is emptied and focused", async () => {
    await refuse(new CloudApiError("cloud_provider_credential_invalid", 422));
    expect(fieldLine()).toContain("Agent37 rejected that key. Paste it again, or make a new one.");
    expect(fieldLine()).not.toContain("Sent once");
    expect(text()).not.toContain("•".repeat(24));
    expect(page.byLabel("Paste Agent37 API key")).not.toBeNull();
    expect(document.activeElement).toBe(keyInput());
    expect(consent().checked).toBe(true);
    expect(isOff(buttonNamed("Connect"))).toBe(true);
  });

  it("14 the key lacks a permission: the console's sentence, and the key stays", async () => {
    await refuse(new CloudApiError("cloud_provider_permission_denied", 403));
    expect(fieldLine()).toContain("The key is valid but not allowed to do something TerminalX needs. Check the permissions of the key.");
    expect(text()).toContain("•".repeat(24));
    expect(isOff(buttonNamed("Connect"))).toBe(false);
  });

  it("15 the provider needs billing set up", async () => {
    await refuse(new CloudApiError("cloud_provider_billing_required", 402));
    expect(fieldLine()).toContain("Agent37 needs billing set up on that account before it will act.");
    expect(isOff(buttonNamed("Connect"))).toBe(false);
  });

  it.each([["cloud_provider_unavailable", 503], ["cloud_provider_rate_limited", 429]])("16 the provider is not answering (%s): under the form, Connect stays on", async (code, status) => {
    await refuse(new CloudApiError(code, status));
    expect(page.byId("connect-refused")!.textContent).toBe("Agent37 is not answering right now. The key was not stored. Try again in a moment.");
    expect(fieldLine()).toContain("Sent once, encrypted at rest, and never shown again, here or anywhere.");
    expect(text()).toContain("•".repeat(24));
    expect(isOff(buttonNamed("Connect"))).toBe(false);
  });

  it("17 no network: the request never left", async () => {
    await refuse(new CloudApiError("cloud_workspace_unavailable", null, "network"));
    expect(page.byId("connect-refused")!.textContent).toBe("No connection. The key was not sent. Try again when the phone is back online.");
    expect(isOff(buttonNamed("Connect"))).toBe(false);
  });

  it("a timeout reads the provider list before saying anything: a key that was stored is connected", async () => {
    const api = await showProvider([agent37()], "agent37");
    expect(api.providers).toHaveBeenCalledTimes(1);
    api.providers.mockResolvedValue([agent37({ availability: "available", connection: connection(Date.now(), Date.now()) })]);
    api.connectProvider.mockRejectedValue(new CloudApiError("cloud_workspace_unavailable", null, "timeout"));
    await pasteAndAccept();
    await page.press(buttonNamed("Connect"));
    await settle();
    // The page's own read, the one after the timeout, and the page's refresh once it is connected.
    expect(api.providers).toHaveBeenCalledTimes(3);
    expect(page.byId("connect-refused")).toBeNull();
    expect(page.byId("provider-connected")).not.toBeNull();
  });

  it("a timeout after which the list shows no key says so in plain words, and keeps the key for another try", async () => {
    const api = await refuse(new CloudApiError("cloud_workspace_unavailable", null, "timeout"));
    expect(api.providers).toHaveBeenCalledTimes(2);
    expect(page.byId("connect-refused")!.textContent).toBe("The service could not be reached. Try again in a moment.");
    expect(text()).toContain("•".repeat(24));
  });

  it("a code with no sentence of its own gets the generic one, never the code", async () => {
    await refuse(new CloudApiError("cloud_provider_brand_new", 409));
    expect(page.byId("connect-refused")!.textContent).toBe("That did not work. Try again in a moment.");
    expect(text()).not.toContain("cloud_provider_brand_new");
  });
});

describe("later: replace, a key that stopped working, disconnect", () => {
  const attentive = () => boat({ availability: "attention-required", connection: connection(Date.now() - DAY, Date.now(), "attention-required") });

  it("18 needs attention: the sentence, and Replace key leads", async () => {
    await showProvider([attentive()], "box");
    expect(page.byId("provider-attention")).not.toBeNull();
    expect(text()).toContain("Needs attention");
    expect(page.byId("provider-attention-notice")!.textContent).toBe("Boat rejected the stored key on its last check. Replace the key to continue. Workspaces on it cannot be started until then.");
    expect(text()).not.toContain("The key itself is never shown again");
    expect(page.styleOf(buttonNamed("Replace key")).backgroundColor).not.toBe(page.styleOf(buttonNamed("Disconnect…")).backgroundColor);
    await page.press(buttonNamed("Replace key"));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/cloud/compute/box?orgId=org-1&replace=1");
    expect(text()).not.toContain("Check again");
  });

  it("19 replace the key: the form under another title, then back to the provider", async () => {
    const api = await showProvider([boat({ availability: "available", connection: connection(Date.now() - DAY, Date.now()) })], "box", true);
    expect(page.byId("screen-header")!.dataset.title).toBe("Replace Boat key");
    expect(page.container.querySelector("[role='link']")).toBeNull();
    expect(isOff(buttonNamed("Replace key"))).toBe(true);
    await pasteAndAccept("Boat API token");
    await page.press(buttonNamed("Replace key"));
    await settle();
    expect(api.connectProvider).toHaveBeenCalledExactlyOnceWith("org-1", "box", KEY, { providerBilling: true, organizationUse: true });
    expect(mocks.back).toHaveBeenCalledOnce();
    expect(page.container.innerHTML).not.toContain("•".repeat(24));
  });

  it("20 disconnect asks first, then goes back", async () => {
    const api = await showProvider([boat({ availability: "available", connection: connection(Date.now() - DAY, Date.now()) })], "box");
    await page.press(buttonNamed("Disconnect…"));
    expect(api.disconnectProvider).not.toHaveBeenCalled();
    const [heading, detail, choices] = vi.mocked(Alert.alert).mock.calls[0]!;
    expect(heading).toBe("Disconnect Boat?");
    expect(detail).toBe("Existing workspaces keep running. New ones cannot be launched on Boat until a key is connected again.");
    expect(choices!.map((choice) => [choice.text, choice.style])).toEqual([["Cancel", "cancel"], ["Disconnect", "destructive"]]);
    await act(async () => { choices![1]!.onPress!(); });
    await settle();
    expect(api.disconnectProvider).toHaveBeenCalledExactlyOnceWith("org-1", "box");
    expect(mocks.back).toHaveBeenCalledOnce();
  });

  it("21 disconnect refused while the provider holds workspaces: say to delete them first", async () => {
    const api = await showProvider([boat({ availability: "available", connection: connection(Date.now() - DAY, Date.now()) })], "box");
    api.disconnectProvider.mockRejectedValue(new CloudApiError("cloud_provider_disposition_required", 409));
    await page.press(buttonNamed("Disconnect…"));
    await act(async () => { vi.mocked(Alert.alert).mock.calls[0]![2]![1]!.onPress!(); });
    await settle();
    const [heading, detail, choices] = vi.mocked(Alert.alert).mock.calls[1]!;
    expect(heading).toBe("Boat still holds workspaces");
    expect(detail).toBe("Delete this organization’s workspaces on Boat first, then disconnect. Nothing was changed.");
    expect(choices!.map((choice) => choice.text)).toEqual(["OK"]);
    expect(mocks.back).not.toHaveBeenCalled();
    expect(isOff(buttonNamed("Disconnect…"))).toBe(false);
  });

  it("a member who opens a provider's page sees it and nothing to do", async () => {
    await showProvider([boat({ availability: "available", canManage: false })], "box");
    expect(text()).toContain("An organization owner or admin must connect compute.");
    expect(page.container.querySelector("input")).toBeNull();
    expect(page.container.querySelectorAll("[role='button']")).toHaveLength(0);
  });
});

describe("the key", () => {
  it("reaches no route, no alert, no error line and no page text, sent or refused", async () => {
    const api = await showProvider([agent37()], "agent37");
    api.connectProvider.mockRejectedValueOnce(new CloudApiError("cloud_provider_unavailable", 503));
    await pasteAndAccept();
    await page.press(buttonNamed("Connect"));
    await settle();
    await page.press(buttonNamed("Connect"));
    await settle();
    expect(api.connectProvider).toHaveBeenCalledTimes(2);
    expect(JSON.stringify([mocks.push.mock.calls, mocks.back.mock.calls, vi.mocked(Alert.alert).mock.calls, mocks.browse.mock.calls])).not.toContain(KEY);
    expect(page.container.innerHTML).not.toContain(KEY);
  });

  it("is emptied from its field once it is stored", async () => {
    const api = await showProvider([agent37()], "agent37");
    let resolve!: (value: CloudProviderConnection) => void;
    api.connectProvider.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await pasteAndAccept();
    await page.press(buttonNamed("Connect"));
    await act(async () => { resolve(answer("agent37")); });
    await settle();
    expect(page.byId("connect-form")).toBeNull();
    expect(page.container.innerHTML).not.toContain("•".repeat(24));
  });
});
