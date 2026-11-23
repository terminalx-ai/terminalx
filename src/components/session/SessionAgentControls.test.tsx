import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@/lib/api";
import type { AgentAccount, AgentAccounts } from "@/lib/agentAccounts";
import type { HarnessInfo } from "@/types/session";

// The agents' model lists and the Mac's account index are read from the machine; the rest is real.
const catalog = vi.hoisted(() => ({ models: [] as ModelInfo[] }));
vi.mock("@/lib/models", async (original) => ({
  ...(await original<typeof import("@/lib/models")>()),
  useModels: (harness?: string) => catalog.models.filter((m) => !harness || m.harness === harness),
}));
const index = vi.hoisted(() => ({ views: {} as Record<string, AgentAccounts> }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: { harness: string }) => {
    if (command !== "agent_accounts_list") throw new Error(`unexpected command ${command}`);
    if (!index.views[args.harness]) throw new Error("no index");
    return index.views[args.harness];
  }),
}));

const { SessionAgentControls } = await import("./SessionAgentControls");
const { AgentMenu } = await import("./AgentMenu");
const { forgetAgentAccounts, launchDefaults, useSessionAgent } = await import("@/lib/useSessionAgent");
type LaunchSettings = import("@/lib/useSessionAgent").LaunchSettings;

const HARNESSES = [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }] as HarnessInfo[];
const WORK = "0123456789abcdef";
const account = (id: string, label: string): AgentAccount => ({
  id, agent: "claude", kind: "subscription", label, email: null, plan: null, organization: null, local: id === "local", isDefault: id === "local", missing: false, addedAt: null,
});
const one: AgentAccounts = { agent: "claude", accounts: [account("local", "This Mac's login")], defaultAccount: "local", projectDefaults: {} };
const two: AgentAccounts = { agent: "claude", accounts: [account("local", "This Mac's login"), account(WORK, "work@example.com · Max")], defaultAccount: "local", projectDefaults: { "/repos/raccoon": WORK } };

/** A handoff's form: it owns its launch settings, and shows what it would send. */
function Form({ project }: { project: string | null }) {
  const [value, setValue] = useState<LaunchSettings>(launchDefaults());
  const selection = useSessionAgent(HARNESSES, true, null, { value, onChange: setValue }, undefined, project);
  return <><SessionAgentControls selection={selection} /><output>{selection.accountId ?? "none"}</output></>;
}

/** New Session's chip, as it draws from the saved preferences. */
function Chip({ project }: { project: string | null }) {
  const selection = useSessionAgent(HARNESSES, true, null, undefined, undefined, project);
  return <><AgentMenu selection={selection} /><output>{selection.accountId ?? "none"}</output></>;
}

beforeEach(() => {
  localStorage.clear();
  forgetAgentAccounts();
  index.views = {};
  catalog.models = [{ id: "opus", label: "Opus", harness: "claude", efforts: ["low", "high"], defaultEffort: "high", acceptsImages: true, isDefault: true, upgrade: null, description: null }];
});
afterEach(cleanup);

const sent = () => screen.getByRole("status").textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("the account picker in the shared launch settings (#980)", () => {
  it("is hidden with one account, and the launch names none", async () => {
    index.views.claude = one;
    render(<Form project="/repos/raccoon" />);
    await settle();
    expect(screen.queryByTitle("Account")).toBeNull();
    expect(screen.getByTitle("Agent")).toBeTruthy();
    expect(sent()).toBe("none");
  });

  it("is shown with two accounts, preselects the project's default, and launches on the one picked", async () => {
    index.views.claude = two;
    render(<Form project="/repos/raccoon" />);
    const pill = await screen.findByTitle("Account");
    expect(pill.textContent).toContain("work@example.com · Max");
    expect(sent()).toBe(WORK);
    fireEvent.click(pill);
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["This Mac's logindefault", "work@example.com · Max"]);
    expect(items[1].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(items[0]);
    await waitFor(() => expect(sent()).toBe("local"));
    expect(screen.getByTitle("Account").textContent).toContain("This Mac's login");
  });

  it("starts outside the project on the agent's default", async () => {
    index.views.claude = two;
    render(<Form project={null} />);
    expect((await screen.findByTitle("Account")).textContent).toContain("This Mac's login");
    expect(sent()).toBe("local");
  });

  it("puts the account on New Session's chip only with several accounts", async () => {
    index.views.claude = one;
    const { unmount } = render(<Chip project="/repos/raccoon" />);
    await settle();
    expect(screen.queryByTestId("agent-account")).toBeNull();
    expect(screen.getByTestId("agent-menu").getAttribute("aria-label")).toBe("Opus High, Ask every time");
    unmount();
    forgetAgentAccounts();
    index.views.claude = two;
    render(<Chip project="/repos/raccoon" />);
    await waitFor(() => expect(screen.getByTestId("agent-account").textContent).toBe("work@example.com · Max"));
    expect(screen.getByTestId("agent-menu").getAttribute("aria-label")).toBe("Opus High on work@example.com · Max, Ask every time");
    expect(sent()).toBe(WORK);
  });
});
