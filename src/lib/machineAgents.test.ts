import { describe, expect, it } from "vitest";
import type { RuntimeAgent, RuntimeAgentsReport } from "@terminalx/portable/workspace";
import { agentRowAction, agentRowLine, machineAgentRows, signInOwner } from "./machineAgents";

const agent = (patch: Partial<RuntimeAgent>): RuntimeAgent => ({ id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "", ...patch });

const CURRENT: RuntimeAgentsReport = {
  agents: [agent({ id: "claude", name: "Claude Code", version: "2.4.1", signIn: "signedIn", signInCheckedAt: 1 }), agent({ id: "codex", name: "Codex", version: "0.62.0", signIn: "signedOut", signInCheckedAt: 1 })],
  missing: [{ id: "gemini", name: "Gemini CLI", installable: true }, { id: "amp", name: "Amp", installable: false }],
};

describe("a machine's agents (PRO-350, 21.10)", () => {
  it("lists installed agents, then the missing ones", () => {
    const rows = machineAgentRows(CURRENT);
    expect(rows.map((row) => [row.id, row.installed, row.signIn])).toEqual([
      ["claude", true, "signedIn"],
      ["codex", true, "signedOut"],
      ["gemini", false, null],
      ["amp", false, null],
    ]);
  });

  it("says each row's state as the screen does", () => {
    const [claude, codex, gemini, amp] = machineAgentRows(CURRENT);
    const owner = signInOwner({ hasWindow: false, os: { family: "linux" } });
    expect(agentRowLine(claude, owner)).toBe("2.4.1 · sessions here use this server’s sign-in");
    expect(agentRowLine(codex, owner)).toBe("Installed · not signed in");
    expect(agentRowLine(gemini, owner)).toBe("Not installed");
    expect(agentRowLine(amp, owner)).toBe("Not installed · install it on the machine");
    expect(agentRowAction(claude, true)).toBeNull();
    expect(agentRowAction(codex, true)).toBe("login");
    expect(agentRowAction(gemini, true)).toBe("install");
    expect(agentRowAction(amp, true)).toBeNull();
  });

  it("offers nothing without machine/4", () => {
    for (const row of machineAgentRows(CURRENT)) expect(agentRowAction(row, false)).toBeNull();
  });

  it("shows an older runtime's agents without a state, and no missing agents", () => {
    const rows = machineAgentRows({ agents: [agent({ id: "codex", name: "Codex" })], missing: null });
    expect(rows).toEqual([{ id: "codex", name: "Codex", installed: true, version: null, signIn: null, installable: false }]);
    expect(agentRowLine(rows[0], "this server’s")).toBe("Installed");
    expect(agentRowAction(rows[0], true)).toBeNull();
  });

  it("offers Sign in again for a sign-in the CLI could not tell", () => {
    const [row] = machineAgentRows({ agents: [agent({ version: "2.4.1", signIn: "unknown" })], missing: [] });
    expect(agentRowLine(row, "this computer’s")).toBe("2.4.1 · its sign-in could not be checked");
    expect(agentRowAction(row, true)).toBe("login");
  });

  it("names whose sign-in sessions use", () => {
    expect(signInOwner({ hasWindow: false, os: { family: "linux" } })).toBe("this server’s");
    expect(signInOwner({ os: { family: "macos" } })).toBe("this computer’s");
    expect(signInOwner({ hasWindow: true, os: { family: "linux" } })).toBe("this machine’s");
  });
});
