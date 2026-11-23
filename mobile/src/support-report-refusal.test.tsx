// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SupportReportScreen from "../app/support-report";
import { HostConnection, type ConnectionLogEntry } from "./transport/connection";
import { endPairingInstance } from "./store/pairing-instance";
import type { HostCredential, StoredHost } from "./store/hosts";

// #1315: the Mac revokes this phone, and the relay refuses its credential.
// The real HostConnection and RelayClient run over a stubbed WebSocket, and
// the real report screen reads the real connection log and pairing state.
const support = vi.hoisted(() => ({ preview: vi.fn(), submit: vi.fn(), copy: vi.fn(), hosts: vi.fn() }));
const mocks = vi.hoisted(() => ({ app: {} as any, back: vi.fn() }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/support/api", () => ({ supportApi: support }));
vi.mock("expo-clipboard", () => ({ setStringAsync: support.copy }));
vi.mock("@mobile/store/hosts", () => ({ readHosts: support.hosts, updateStoredHost: vi.fn(async () => undefined), writeHostCredential: vi.fn(async () => undefined) }));
// Rotation follows only a relay connection that is accepted, which none here is.
vi.mock("@mobile/transport/credential-rotation", () => ({ rotateCredentialIfNeeded: async (args: unknown) => args }));
vi.mock("@mobile/transport/e2ee-keypair", () => ({ loadOrCreateE2EESecretKey: async () => new Uint8Array(32).fill(9) }));
vi.mock("expo-router", () => ({ usePreventRemove: () => undefined, useRouter: () => ({ back: mocks.back }) }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.2.36", ios: { buildNumber: "120" } } } }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: { ink: "#fff", muted: "#999", border: "#333" } }) }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({ accessibilityLabel, value, onChangeText }: any) => <input aria-label={accessibilityLabel} value={value} onChange={(event) => onChangeText(event.currentTarget.value)} />,
  Switch: ({ value, onValueChange, accessibilityLabel }: any) => <input type="checkbox" role="switch" aria-label={accessibilityLabel} checked={!!value} onChange={(event) => onValueChange(event.currentTarget.checked)} />,
  Platform: { OS: "ios" }, Linking: { openURL: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button onClick={onPress} disabled={disabled}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>, Screen: ({ children }: any) => <div>{children}</div>,
}));

/** A relay socket the test answers for the relay: it opens, then accepts or refuses the resume credential, or the network drops it. */
class RelaySocket {
  static readonly OPEN = 1;
  static opened: RelaySocket[] = [];
  readonly OPEN = 1;
  binaryType = "";
  readyState = RelaySocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  sent: unknown[] = [];
  constructor(readonly url: string) { RelaySocket.opened.push(this); }
  send(value: unknown) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

const owner = "my-account";
const machine: StoredHost = {
  id: "studio", label: "Studio", publicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", endpoint: "ws://127.0.0.1:0", lastConnectedAt: 1,
  relay: { v: 1, directorUrl: "https://relay.example", cellUrl: "https://relay.example", assignmentEpoch: 1, relayHostId: "1234567890123456", e2eeFraming: 2 },
  provenance: { kind: "automatic", userId: owner },
};
const credential = (token: string): HostCredential => ({ v: 1, deviceToken: `device-${token}`, current: { token: token.padEnd(43, "x"), hash: "h".repeat(43), version: 1, expiresAt: Date.now() + 1_000_000 } });

let root: Root;
let container: HTMLDivElement;
let connection: HostConnection;
let logs: ConnectionLogEntry[];
const settle = () => act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });
const show = (screen: ReactNode) => act(async () => { root.render(screen); });
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label);
const tap = async (label: string) => { await act(async () => button(label)!.click()); await settle(); };

/** The relay's answer to the attempt under way: the network drops it, or the relay refuses the credential. */
async function relayAnswers(answer: "network" | "refused") {
  await settle();
  const socket = RelaySocket.opened.at(-1)!;
  await act(async () => {
    socket.onopen?.();
    if (answer === "network") socket.onclose?.({ code: 1006, reason: "The network connection was lost." });
    else socket.onmessage?.({ data: JSON.stringify({ type: "relay-hello", ok: false, code: 4401 }) });
  });
  await settle();
}
/** The next attempt starts at once, as Retry does. */
async function nextAttempt(answer: "network" | "refused") {
  await act(async () => connection.retryNow());
  await relayAnswers(answer);
}

async function preparePreview() {
  await show(<SupportReportScreen />);
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="This phone’s connection events"]')!.click());
  await tap("Prepare preview");
  expect(container.textContent).toContain("Review diagnostic fields");
}
const sentEvents = () => support.submit.mock.calls.at(-1)![1].local.events as { kind: string }[];
/** The kinds sent, in alphabetical order. A report lists the newest event first, and two events in the same millisecond keep the order they were logged in, so the order sent depends on whether the clock ticked between them. */
const sentKinds = () => sentEvents().map(({ kind }) => kind).sort();
/** The screen keeps a delivered report until Done; each test that delivers one ends there. */
const done = async () => { expect(container.textContent).toContain("Report delivered"); await tap("Done"); };
const changed = "Pairing access changed";

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  RelaySocket.opened = [];
  vi.stubGlobal("WebSocket", RelaySocket);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("director offline"); }));
  for (const fn of [support.preview, support.submit, support.copy, mocks.back]) fn.mockReset();
  support.hosts.mockReset().mockImplementation(async () => mocks.app.hosts);
  support.copy.mockResolvedValue(true);
  support.preview.mockImplementation(async (_owner: string, request: { to?: number }) => {
    const now = Date.now();
    return { key: "a".repeat(43), from: now - 3_600_000, to: request.to ?? now, server: { status: "omitted", events: [], capturedAt: now, truncated: false } };
  });
  support.submit.mockImplementation(async (_owner: string, _request: unknown, authorize: () => Promise<void>) => {
    await authorize();
    return { reference: "11111111-2222-4333-8444-555555555555" };
  });
  endPairingInstance(machine.id);
  logs = [];
  connection = new HostConnection();
  connection.onLog((entry) => logs.push(entry));
  mocks.app = { session: { user: { userId: owner } }, hosts: [machine], logs };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  connection.start(machine, credential("first"));
  await relayAnswers("network");
});
afterEach(async () => {
  connection.stop();
  // A test that failed before Done must not leave its delivered report to the next one.
  await show(<SupportReportScreen />);
  if (button("Done")) await tap("Done");
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps a draft through network failures, and sends the pairing's events", async () => {
  await preparePreview();
  await nextAttempt("network");
  expect(container.textContent).not.toContain(changed);
  await tap("Send to TerminalX Support");
  expect(container.textContent).toContain("Report delivered");
  // The draft holds what was reviewed: the events up to the preview, newest first.
  expect(sentKinds()).toEqual(["attempt-failed", "connecting"]);
  await done();
});

it("prepares a fresh preview without any event of a pairing the relay refused", async () => {
  await nextAttempt("refused");
  await preparePreview();
  expect(container.textContent).toContain("Phone: ");
  await tap("Send to TerminalX Support");
  expect(sentEvents()).toEqual([]);
  await done();
});

it("withdraws an open draft the moment the credential is refused, with no change to the saved machines", async () => {
  await preparePreview();
  await tap("Review diagnostic fields");
  expect(container.textContent).toContain("attempt-failed");
  await nextAttempt("refused");
  expect(mocks.app.hosts).toEqual([machine]);
  expect(container.textContent).toContain(changed);
  expect(container.textContent).not.toMatch(/attempt-failed|Review diagnostic fields|Copy local report|Send to TerminalX Support/);
  expect(support.copy).not.toHaveBeenCalled();
  expect(support.submit).not.toHaveBeenCalled();
});

it("does not offer a retained, attempted report again after the refusal", async () => {
  support.submit.mockRejectedValueOnce(new Error("offline"));
  await preparePreview();
  await tap("Send to TerminalX Support");
  expect(button("Retry same report")).toBeDefined();
  await show(<div />);
  await nextAttempt("refused");
  await show(<SupportReportScreen />);
  expect(container.textContent).toContain(changed);
  expect(button("Retry same report")).toBeUndefined();
  expect(support.submit).toHaveBeenCalledTimes(1);
});

it("refuses to copy when the credential is refused while the copy is being authorized", async () => {
  await preparePreview();
  support.hosts.mockImplementationOnce(async () => { await nextAttempt("refused"); return mocks.app.hosts; });
  await tap("Copy local report");
  expect(container.textContent).toContain(changed);
  expect(support.copy).not.toHaveBeenCalled();
});

it("refuses to send when the credential is refused while the report is being sent", async () => {
  await preparePreview();
  support.submit.mockImplementationOnce(async (_owner: string, _request: unknown, authorize: () => Promise<void>) => {
    await nextAttempt("refused");
    await authorize();
    return { reference: "11111111-2222-4333-8444-555555555555" };
  });
  await tap("Send to TerminalX Support");
  expect(container.textContent).toContain(changed);
  expect(container.textContent).not.toContain("Report delivered");
});

it("does not bring back the refused pairing's events once the phone is paired again", async () => {
  await nextAttempt("refused");
  // Pairing again saves the machine (savePairedHost ends its instance) and connects with the new credential.
  endPairingInstance(machine.id);
  connection.start(machine, credential("second"));
  await relayAnswers("network");
  await preparePreview();
  await tap("Send to TerminalX Support");
  expect(sentKinds()).toEqual(["attempt-failed", "connecting"]);
  await done();
});
