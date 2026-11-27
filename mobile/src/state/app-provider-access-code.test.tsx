// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PRO-551: a sign-in the server holds at the private beta, through the app's real sign-in
// (src/auth/native.ts and protocol.ts). Only the keychain, the system sign-in sheet and
// the network are stood in for, so what is stored, logged and sent is what the app does.

const TICKET = "cah_3f2c9d.Zx9-ticket-secret";
const EMAIL = "person@example.com";
const SESSION = { accessToken: "access-new", refreshToken: "refresh-new", expiresAt: 1_795_200_000_000, user: { userId: "u-new", email: EMAIL } };
const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  /** How the server answers the code exchange and each redeem, in order. */
  sessionAnswer: { status: 403, body: {} as unknown },
  redeemAnswers: [] as { status: number; body: unknown }[],
  requests: [] as { url: string; body: Record<string, unknown> }[],
  /** The sign-in sheet: closes with the callback once released. */
  sheet: null as null | (() => void),
  holdSheet: false,
  /** NetInfo: its listener, and how often the app asked it to read the network again. */
  network: null as null | ((state: unknown) => void),
  refreshed: 0,
  /** The redeem request cannot be made at all, as with no route to the server. */
  unreachable: false,
}));
vi.mock("@react-native-community/netinfo", () => ({ default: {
  addEventListener: (listener: (state: unknown) => void) => { fake.network = listener; return () => undefined; },
  refresh: async () => { fake.refreshed++; return { type: "none", isConnected: false, details: null }; },
} }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async (key: string) => fake.storage.get(key) ?? null, setItem: async (key: string, value: string) => void fake.storage.set(key, value), removeItem: async (key: string) => void fake.storage.delete(key) } }));
vi.mock("expo-secure-store", () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1, getItemAsync: async (key: string) => fake.storage.get(`secure:${key}`) ?? null, setItemAsync: async (key: string, value: string) => void fake.storage.set(`secure:${key}`, value), deleteItemAsync: async (key: string) => void fake.storage.delete(`secure:${key}`) }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" }, CryptoEncoding: { BASE64: "base64" },
  getRandomBytesAsync: async (length: number) => Uint8Array.from({ length }, (_, index) => index + 1),
  digestStringAsync: async () => "Y2hhbGxlbmdl",
}));
vi.mock("expo-web-browser", () => ({
  // The sign-in page signs the person in and sends the phone back with the state it was opened with.
  openAuthSessionAsync: async () => {
    if (fake.holdSheet) await new Promise<void>((resolve) => { fake.sheet = resolve; });
    return { type: "success", url: `terminalx://auth/callback?code=auth-code&state=${encodeURIComponent(fake.storage.get("secure:terminalx.cloud.pkce.state") ?? "")}` };
  },
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Linking: { getInitialURL: async () => null, addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: "ios", constants: { interfaceIdiom: "phone" } },
}));
vi.mock("../notifications/local", () => ({ handleNotificationEvent: vi.fn(), restoreLocalNotifications: vi.fn() }));
vi.mock("../pairing/account", () => ({ discoverMachines: vi.fn(async () => ({ hosts: [], state: "ready" })), pairDiscoveredMachine: vi.fn(), signOutPairing: vi.fn() }));
vi.mock("../pairing/pair", () => ({ recoverPendingPairing: async () => null, pairFromOffer: vi.fn() }));
vi.mock("../transport/connection", () => ({
  HostConnection: class {
    start() {} stop() {} restart() {} background() {} foreground() { return true; } networkChanged() {}
    onStage() { return () => undefined; } onConnected() { return () => undefined; } onLog() { return () => undefined; } onEvent() { return () => undefined; }
  },
}));
vi.mock("../data/host-api", () => ({ HostApi: class { resetConnection() {} describeHost = async () => null; summaries = async () => []; listVersion = () => null; rememberList() {} } }));

const { AppProvider, useApp } = await import("./AppProvider");

const seen: { current: ReturnType<typeof useApp> | null } = { current: null };
function Probe() {
  const app = useApp();
  useEffect(() => { seen.current = app; });
  return null;
}
let root: Root;
const app = () => seen.current!;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const logged: string[] = [];

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const accepted = { status: 200, body: { status: "accepted", ...SESSION } };
/** Everything the app wrote to the phone and to its logs, to look for the ticket in. */
const written = () => [...fake.storage.entries()].flat().join("\n") + logged.join("\n");

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  fake.storage.clear();
  fake.sessionAnswer = { status: 403, body: { error: "access_code_required", accessTicket: TICKET, accessTicketExpiresAt: 1_795_200_000_000, email: EMAIL } };
  fake.redeemAnswers = [];
  fake.requests = [];
  fake.holdSheet = false;
  fake.network = null;
  fake.refreshed = 0;
  fake.unreachable = false;
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    fake.requests.push({ url, body });
    if (url.endsWith("/v1/auth/session")) return respond(fake.sessionAnswer.status, fake.sessionAnswer.body);
    if (url.endsWith("/v1/auth/access-code/redeem")) {
      // React Native's fetch, when no connection can be made.
      if (fake.unreachable) throw new TypeError("Network request failed");
      const next = fake.redeemAnswers.shift()!; return respond(next.status, next.body);
    }
    return respond(404, { error: "not_found" });
  }));
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const signIn = async () => { await act(async () => { await app().signIn(); }); await settle(); };
const redeem = async (code: string) => { let answer: unknown; await act(async () => { answer = await app().redeemAccessCode(code); }); await settle(); return answer; };

describe("a sign-in held at the private beta", () => {
  it("is held, not signed in and not an error, whether the person signed in by email or by Google: both end at the same exchange", async () => {
    await signIn();
    expect(app().session).toBeNull();
    expect(app().error).toBeNull();
    expect(app().accessCode).toEqual({ id: 1, email: EMAIL });
    expect(app().signingIn).toBe(false);
    expect(fake.requests.map((request) => request.url)).toEqual(["https://login.terminalx.ai/v1/auth/session"]);
  });

  it("keeps the ticket in memory only: not in what the screens see, not on the phone, not in a log", async () => {
    await signIn();
    expect(JSON.stringify(app().accessCode)).not.toContain(TICKET);
    expect(written()).not.toContain(TICKET);
    expect(fake.storage.has("secure:terminalx.cloud.session.v1")).toBe(false);
  });

  it("shows the wait from the sheet closing until the phone knows whether a code is needed", async () => {
    fake.holdSheet = true;
    let done!: Promise<void>;
    await act(async () => { done = app().signIn(); });
    expect(app().signingIn).toBe(true);
    expect(app().accessCode).toBeNull();
    await act(async () => { fake.sheet!(); await done; });
    await settle();
    expect(app().signingIn).toBe(false);
    expect(app().accessCode?.email).toBe(EMAIL);
  });

  it("redeems a code with the ticket; accepted, the person is signed in and the session kept as after any sign-in", async () => {
    await signIn();
    fake.redeemAnswers = [accepted];
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "accepted" });
    expect(fake.requests.at(-1)).toEqual({ url: "https://login.terminalx.ai/v1/auth/access-code/redeem", body: { accessTicket: TICKET, code: "K7QM2X9TRB", clientId: "terminalx-mobile" } });
    expect(app().session).toEqual(SESSION);
    expect(JSON.parse(fake.storage.get("secure:terminalx.cloud.session.v1")!)).toEqual(SESSION);
    // The page says so for a moment before it closes.
    expect(app().accessCode).not.toBeNull();
    await act(async () => app().finishAccessCode());
    expect(app().accessCode).toBeNull();
    expect(written()).not.toContain(TICKET);
    // The ticket is spent: nothing more is sent with it.
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "ticket_dead" });
    expect(fake.requests.filter((request) => request.url.endsWith("/redeem"))).toHaveLength(1);
  });

  it.each([
    [404, "invalid"],
    [410, "expired"],
    [409, "exhausted"],
  ] as const)("refused (%i %s), the ticket stays for another code", async (status, error) => {
    await signIn();
    fake.redeemAnswers = [{ status, body: { error } }, accepted];
    expect(await redeem("K7QM2X9TR8")).toEqual({ status: error });
    expect(app().session).toBeNull();
    expect(app().accessCode).not.toBeNull();
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "accepted" });
    expect(fake.requests.filter((request) => request.url.endsWith("/redeem")).map((request) => request.body.accessTicket)).toEqual([TICKET, TICKET]);
  });

  it("too many tries: the wait is handed to the screen, and the ticket stays", async () => {
    await signIn();
    fake.redeemAnswers = [{ status: 429, body: { error: "rate_limited", retryAfter: 4 } }];
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "rate_limited", retryAfter: 4 });
    expect(app().accessCode).not.toBeNull();
  });

  it("no answer: said so, and a second try sends the same ticket", async () => {
    await signIn();
    fake.redeemAnswers = [{ status: 500, body: { error: "server_error" } }, accepted];
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "unanswered", reason: "redeem_failed_500" });
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "accepted" });
  });

  it("a dead ticket (401 invalid_grant) is dropped; signing in again holds afresh with a new ticket", async () => {
    await signIn();
    fake.redeemAnswers = [{ status: 401, body: { error: "invalid_grant" } }];
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "ticket_dead" });
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "ticket_dead" });
    expect(fake.requests.filter((request) => request.url.endsWith("/redeem"))).toHaveLength(1);
    fake.sessionAnswer = { status: 403, body: { error: "access_code_required", accessTicket: "cah_second", accessTicketExpiresAt: 1_795_200_000_000, email: EMAIL } };
    await signIn();
    expect(app().accessCode).toEqual({ id: 2, email: EMAIL });
    fake.redeemAnswers = [accepted];
    await redeem("K7QM2X9TRB");
    expect(fake.requests.at(-1)?.body.accessTicket).toBe("cah_second");
  });

  it("a second sign-in that finds access already given (an invite meanwhile) signs in and ends the hold", async () => {
    await signIn();
    fake.sessionAnswer = { status: 200, body: SESSION };
    await signIn();
    expect(app().session).toEqual(SESSION);
    expect(app().accessCode).toBeNull();
  });

  it("Cancel signs the person out: the hold and its ticket are gone, and nothing is left on the phone", async () => {
    await signIn();
    await act(async () => app().cancelAccessCode());
    expect(app().accessCode).toBeNull();
    expect(app().session).toBeNull();
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "ticket_dead" });
    expect(fake.requests.filter((request) => request.url.endsWith("/redeem"))).toHaveLength(0);
    expect([...fake.storage.keys()].filter((key) => key.startsWith("secure:"))).toEqual([]);
  });

  it("a sign-in that is not held signs in as before", async () => {
    fake.sessionAnswer = { status: 200, body: SESSION };
    await signIn();
    expect(app().session).toEqual(SESSION);
    expect(app().accessCode).toBeNull();
  });
});

// PRO-603: the owner's live check had NetInfo saying offline while the network worked. The app never refuses on the
// reading alone: the code goes, and the server's answer is what says whether the phone is online.
describe("a network reading that says offline", () => {
  const offline = async () => { await act(async () => fake.network!({ type: "none", isConnected: false, details: null })); await settle(); };

  it("does not stop the code: it is sent and accepted, and the answer puts the reading right", async () => {
    await signIn();
    await offline();
    expect(app().online).toBe(false);
    fake.redeemAnswers = [accepted];
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "accepted" });
    expect(fake.requests.at(-1)?.url).toBe("https://login.terminalx.ai/v1/auth/access-code/redeem");
    expect(app().session).toEqual(SESSION);
    expect(app().online).toBe(true);
  });

  it("a request that really cannot be made is unanswered as unreachable, the reading is asked for again, and the next try is sent", async () => {
    await signIn();
    await offline();
    fake.unreachable = true;
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "unanswered", reason: "redeem_unreachable" });
    expect(fake.refreshed).toBe(1);
    expect(app().online).toBe(false);
    expect(app().session).toBeNull();
    fake.unreachable = false;
    fake.redeemAnswers = [accepted];
    expect(await redeem("K7QM2X9TRB")).toEqual({ status: "accepted" });
    expect(fake.requests.filter((request) => request.url.endsWith("/redeem"))).toHaveLength(2);
    expect(app().online).toBe(true);
  });

  it("a refused code is an answer too: the phone is online", async () => {
    await signIn();
    await offline();
    fake.redeemAnswers = [{ status: 404, body: { error: "invalid" } }];
    expect(await redeem("K7QM2X9TRX")).toEqual({ status: "invalid" });
    expect(app().online).toBe(true);
  });
});
