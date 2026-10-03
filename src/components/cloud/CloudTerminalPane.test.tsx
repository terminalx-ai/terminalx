// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceRpcClient, WorkspaceYou } from "@terminalx/portable/workspace";
import type { CloudTerminal } from "@/lib/cloudTerminals";

const mocks = vi.hoisted(() => ({ takeControl: vi.fn(async () => undefined) }));

vi.mock("@/components/terminal/TerminalView", () => ({ TerminalView: () => <div data-testid="xterm" />, createTerminal: vi.fn() }));
vi.mock("@/lib/terminal", () => ({ getInstance: () => ({ fit: { proposeDimensions: () => ({ cols: 120, rows: 40 }) } }) }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => (id: string | null | undefined) => id ?? "Someone" }));
vi.mock("@/lib/cloudTerminals", async (original) => ({ ...(await original<typeof import("@/lib/cloudTerminals")>()), takeControl: mocks.takeControl }));

const { CloudTerminalPane, shouldReclaim } = await import("./CloudTerminalPane");

const terminal = (fields: Partial<CloudTerminal> = {}): CloudTerminal => ({
  id: "cloud:ws:p1",
  ptyId: "p1",
  number: 1,
  title: "Terminal 1",
  epoch: "e1",
  pid: 1,
  exited: false,
  exitCode: null,
  control: "other",
  controllerId: "u-me",
  controllerPresent: false,
  cols: 80,
  rows: 24,
  gone: null,
  inputError: null,
  sessionId: null,
  ...fields,
});
const me = { userId: "u-me", role: "manager" } as unknown as WorkspaceYou;
const client = {} as WorkspaceRpcClient;
const pane = (shown: CloudTerminal, options: { mayControl?: boolean; connected?: boolean } = {}) => (
  <CloudTerminalPane workspace="ws" terminal={shown} client={client} connected={options.connected ?? true} manage={false} mayControl={options.mayControl ?? true} you={me} base={vi.fn()} />
);

beforeEach(() => mocks.takeControl.mockClear());
afterEach(cleanup);

// PRO-84: reopening a cloud session from the same Mac said "Another device controls this terminal".
describe("a terminal whose controller went away", () => {
  it("is taken back once by the same person, at this window's size", async () => {
    const { rerender } = render(pane(terminal()));
    await waitFor(() => expect(mocks.takeControl).toHaveBeenCalledWith("ws", client, "cloud:ws:p1", { cols: 120, rows: 40 }));
    // Still "other" on the next render (the answer has not landed): not asked for twice.
    rerender(pane(terminal({ cols: 81 })));
    expect(mocks.takeControl).toHaveBeenCalledTimes(1);
  });

  it("is left alone while its controller is attached, when it is someone else's, or when this person only views", () => {
    expect(shouldReclaim(terminal({ controllerPresent: true }), true, me)).toBe(false);
    // An older runtime does not say whether the controller is there.
    expect(shouldReclaim(terminal({ controllerPresent: null }), true, me)).toBe(false);
    expect(shouldReclaim(terminal({ controllerId: "u-other" }), true, me)).toBe(false);
    expect(shouldReclaim(terminal(), false, me)).toBe(false);
    expect(shouldReclaim(terminal({ exited: true }), true, me)).toBe(false);
    expect(shouldReclaim(terminal({ gone: "runtime-restarted" }), true, me)).toBe(false);
    expect(shouldReclaim(terminal({ control: "you" }), true, me)).toBe(false);
    expect(shouldReclaim(terminal(), true, me)).toBe(true);

    render(pane(terminal({ controllerPresent: true })));
    expect(mocks.takeControl).not.toHaveBeenCalled();
    expect(screen.getByTestId("cloud-terminal-viewer").textContent).toContain("You control this terminal from another window or device");
  });

  it("waits for the connection before taking it back", () => {
    render(pane(terminal(), { connected: false }));
    expect(mocks.takeControl).not.toHaveBeenCalled();
  });
});
