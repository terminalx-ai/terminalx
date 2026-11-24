import { describe, expect, it, vi } from "vitest";
import type { MachineConnectionState } from "@/types/machines";
import { pairedMachine } from "./machineFixtures.test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const { lastSeenSentence, machineDetailRows, machineStateHint, machineStateLabel, machineTone, machineViewStatus, popoverStateLabel } = await import("./connectionStatus");
const { machineMessageText } = await import("./MachineMessage");

/**
 * PRO-352: every connection state maps to the chip label, the hover text and
 * the colour of screen 21.09, and the session says what that state means.
 */
const NOW = Date.parse("2026-11-15T14:30:00");
const SEEN = Date.parse("2026-11-15T14:02:00");

const STATES: { state: MachineConnectionState; label: string; hint: string; tone: string; view: string }[] = [
  { state: { state: "connecting", trying: ["lan", "relay"] }, label: "Connecting", hint: "Reaching the Mac mini", tone: "connecting", view: "Connecting to Mac mini…" },
  {
    state: { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: 1, rttMs: 9 },
    label: "Direct",
    hint: "On this network or Tailscale",
    tone: "connected",
    view: "Connecting to Mac mini…",
  },
  { state: { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: 41 }, label: "Relay", hint: "Through TerminalX Relay", tone: "connected", view: "Connecting to Mac mini…" },
  {
    state: { state: "reconnecting", lostAt: NOW - 12_000, attempt: 1, retryInMs: 250, trying: ["lan", "relay"] },
    label: "Reconnecting",
    hint: "Lost it 12 seconds ago",
    tone: "reconnecting",
    view: "Reconnecting to Mac mini. Trying this network, then Relay. The agent keeps working there.",
  },
  { state: { state: "offline", lastSeenAt: SEEN, retryInMs: 10_000 }, label: "Offline", hint: "Sessions there keep running", tone: "offline", view: "Mac mini isn’t reachable. Sessions there keep running." },
  {
    state: { state: "needsUpdate", version: "0.2.27", side: "machine" },
    label: "Needs update",
    hint: "Runs an older TerminalX",
    tone: "warning",
    view: "Mac mini runs an older TerminalX. Update TerminalX there to connect.",
  },
  { state: { state: "updating", version: "0.2.34", since: NOW }, label: "Updating", hint: "Back in under a minute", tone: "updating", view: "Mac mini is updating. Back in under a minute. Sessions there keep running." },
  { state: { state: "accessRemoved" }, label: "Access removed", hint: "Revoked on that Mac", tone: "removed", view: "Mac mini no longer allows this computer. Pair again to reconnect." },
];

describe("machine connection states (21.09)", () => {
  const machine = pairedMachine({ machineId: "m1", name: "Mac mini", lastSeenAt: SEEN });

  for (const row of STATES) {
    it(`${row.state.state}: "${row.label}", "${row.hint}"`, () => {
      expect(machineStateLabel(row.state, machine)).toBe(row.label);
      expect(machineStateHint(row.state, "Mac mini", NOW)).toBe(row.hint);
      expect(machineTone(row.state)).toBe(row.tone);
      expect(machineViewStatus(row.state, "Mac mini")).toBe(row.view);
    });
  }

  it("names every state the ticket lists", () => {
    expect(STATES.map((row) => row.label)).toEqual(["Connecting", "Direct", "Relay", "Reconnecting", "Offline", "Needs update", "Updating", "Access removed"]);
  });

  it("adds when an offline machine was last seen in the sidebar, on the 24-hour clock", () => {
    const offline: MachineConnectionState = { state: "offline", lastSeenAt: SEEN, retryInMs: 10_000 };
    expect(machineStateLabel(offline, machine, { seen: true })).toMatch(/^Offline · seen 14:02$/);
    expect(lastSeenSentence(SEEN, NOW)).toBe("Last seen at 14:02.");
    expect(lastSeenSentence(SEEN - 86_400_000, NOW)).toBe("Last seen yesterday at 14:02.");
  });
});

describe("the connection popover (21.09)", () => {
  // keyLabel reads the first four bytes of the id: "fzqRwg" is 7F 3A 91 C2.
  const machine = pairedMachine({ machineId: "fzqRwgAAAAAAAAAA", name: "Mac mini", version: "0.2.33", os: { family: "macos", version: "26.1" }, lastSeenAt: SEEN });
  const direct: MachineConnectionState = { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: 1, rttMs: 9 };

  it("lists the path, encryption, version and what runs there while connected", () => {
    expect(popoverStateLabel(direct, machine)).toBe("Connected");
    expect(machineDetailRows(machine, direct, { running: 3, freeBytes: 14_000_000_000 }, NOW)).toEqual([
      { label: "Path", value: "Direct over Tailscale · 9 ms" },
      { label: "Encryption", value: "End to end · 7F3A·91C2" },
      { label: "TerminalX", value: "0.2.33 · macOS 26.1" },
      { label: "Running", value: "3 sessions · 14 GB memory free" },
    ]);
  });

  it("leaves out what is not known yet, and says when an away machine was last seen", () => {
    expect(machineDetailRows(machine, direct, { running: null, freeBytes: null }, NOW).map((row) => row.label)).toEqual(["Path", "Encryption", "TerminalX"]);
    const offline: MachineConnectionState = { state: "offline", lastSeenAt: SEEN, retryInMs: 10_000 };
    expect(popoverStateLabel(offline, machine)).toBe("Offline");
    expect(machineDetailRows(machine, offline, { running: 3, freeBytes: 1 }, NOW)).toEqual([
      { label: "Path", value: "Sessions there keep running" },
      { label: "Encryption", value: "End to end · 7F3A·91C2" },
      { label: "TerminalX", value: "0.2.33 · macOS 26.1" },
      { label: "Last seen", value: "today at 14:02" },
    ]);
  });
});

describe("inline messages (21.09)", () => {
  it("words each message as the screen does", () => {
    expect(machineMessageText("unreachable", { name: "Mac mini" })).toBe("Mac mini isn't reachable. Sessions there keep running.");
    expect(machineMessageText("signIn", { name: "dev-server", agent: "Claude Code" })).toBe("Claude Code isn't signed in on dev-server. Sign in from its page.");
    expect(machineMessageText("projectMissing", { name: "dev-server", project: "terminalx" })).toBe("terminalx isn't a project on dev-server yet. Add it there first.");
    expect(machineMessageText("accessRemoved", { name: "Studio" })).toBe("Studio no longer allows this computer. Pair again to reconnect.");
    expect(machineMessageText("localOnly", { name: "Studio" })).toBe("Browser and computer use aren't available on another machine.");
  });
});
