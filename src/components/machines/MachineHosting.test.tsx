// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { listeningText } from "@/lib/machineListen";
import type { MachineListenStatus, MachineRunsAs } from "@/types/machines";
import { MachineHosting } from "./MachineHosting";
import { MachinePageHosting } from "./MachinePageHosting";

afterEach(cleanup);

function status(over: Partial<MachineListenStatus> = {}): MachineListenStatus {
  return { choice: "relay", chosen: true, addresses: [], allowPublic: false, askPublic: false, refusedPublicAt: null, ...over };
}
const DEV: MachineRunsAs = { user: "dev", root: false, passwordlessSudo: false };

describe("where a machine listens (PRO-487)", () => {
  it("says what each choice opens and the addresses bound now", () => {
    expect(listeningText(status())).toBe("No port is open.");
    expect(listeningText(status({ choice: "tailscale" }))).toBe("No port is open: it has no address of that kind right now.");
    expect(listeningText(status({ choice: "lan", addresses: ["192.168.1.20:6768", "100.93.49.78:6768"] }))).toBe("Listening on 192.168.1.20:6768 and 100.93.49.78:6768.");
    expect(listeningText(status({ choice: "all", addresses: ["0.0.0.0:6768"] }))).toBe("Listening on every interface, port 6768.");
  });

  it("offers the four choices, and never carries public callers over to another choice", () => {
    const onChange = vi.fn();
    render(<MachineHosting name="dev-server" status={status({ choice: "all", addresses: ["0.0.0.0:6768"], allowPublic: true })} runsAs={DEV} busy={false} onChange={onChange} />);
    const choices = screen.getByRole("radiogroup", { name: "Where dev-server listens" });
    expect(within(choices).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Relay only", "Tailscale", "Local network", "All interfaces"]);
    expect(screen.getByTestId("machine-hosting-listening").textContent).toContain("public ones included");
    fireEvent.click(within(choices).getByRole("radio", { name: "Local network" }));
    expect(onChange).toHaveBeenLastCalledWith("lan", false);
    // Public callers are their own, explicit switch under All interfaces.
    fireEvent.click(screen.getByRole("checkbox", { name: "Answer callers from public addresses" }));
    expect(onChange).toHaveBeenLastCalledWith("all", false);
  });

  it("asks once about a public address from before the setting: keep it, or close it", () => {
    const onChange = vi.fn();
    render(<MachineHosting name="dev-server" status={status({ choice: "all", chosen: false, addresses: ["0.0.0.0:6768"], askPublic: true })} runsAs={DEV} busy={false} onChange={onChange} />);
    const ask = screen.getByTestId("machine-hosting-ask-public");
    expect(ask.textContent).toContain("callers from public addresses are refused until you decide");
    fireEvent.click(within(ask).getByRole("button", { name: "Keep the public address" }));
    expect(onChange).toHaveBeenLastCalledWith("all", true);
    fireEvent.click(within(ask).getByRole("button", { name: "Close it" }));
    expect(onChange).toHaveBeenLastCalledWith("lan", false);
    cleanup();
    render(<MachineHosting name="dev-server" status={status({ choice: "lan", addresses: ["192.168.1.20:6768"] })} runsAs={DEV} busy={false} onChange={onChange} />);
    expect(screen.queryByTestId("machine-hosting-ask-public")).toBeNull();
  });

  it("says it runs as root, and whether its user has passwordless sudo", () => {
    const { rerender } = render(<MachineHosting name="dev-server" status={status()} runsAs={{ user: "root", root: true, passwordlessSudo: null }} busy={false} />);
    const runs = () => screen.getByTestId("machine-hosting-runs-as");
    expect(runs().textContent).toBe("Runs as root. Every paired computer and every agent on it acts as root.");
    expect(runs().dataset.root).toBe("true");
    rerender(<MachineHosting name="dev-server" status={status()} runsAs={{ user: "dev", root: false, passwordlessSudo: true }} busy={false} />);
    expect(runs().textContent).toBe("Runs as dev · Passwordless sudo: paired computers and agents can become root.");
    rerender(<MachineHosting name="dev-server" status={status()} runsAs={DEV} busy={false} />);
    expect(runs().textContent).toBe("Runs as dev · No passwordless sudo.");
    // Shown only: no control without the right to change it.
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("Listening and privileges on a machine's page (PRO-487)", () => {
  function client(described: Record<string, unknown>, setListen: (params: Record<string, unknown>) => unknown = (params) => ({ listen: status({ choice: params.listen as "lan", addresses: ["192.168.1.20:6768"] }) })) {
    const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "machine.describe") return described;
      if (method === "machine.setListen") return setListen(params);
      throw new Error(`unexpected ${method}`);
    });
    return { call, rpc: { call } as unknown as WorkspaceRpcClient };
  }

  it("reads machine.describe, and changes the choice with machine.setListen", async () => {
    const { call, rpc } = client({ listen: status({ choice: "all", chosen: false, addresses: ["0.0.0.0:6768"], askPublic: true }), runsAs: { user: "root", root: true, passwordlessSudo: null } });
    render(<MachinePageHosting name="dev-server" client={rpc} connected manage />);
    const section = await screen.findByTestId("machine-hosting");
    expect(section.dataset.listen).toBe("all");
    expect(screen.getByTestId("machine-hosting-runs-as").textContent).toContain("Runs as root");
    fireEvent.click(screen.getByRole("button", { name: "Close it" }));
    await waitFor(() => expect(screen.getByTestId("machine-hosting").dataset.listen).toBe("lan"));
    expect(call).toHaveBeenCalledWith("machine.setListen", { listen: "lan", allowPublic: false });
    expect(screen.queryByTestId("machine-hosting-ask-public")).toBeNull();
  });

  it("shows the machine's refusal, and offers no control to a computer that may not manage it", async () => {
    const refusing = client({ listen: status({ choice: "lan", addresses: ["192.168.1.20:6768"] }), runsAs: DEV }, () => {
      throw new Error("dev-server is not registered with the relay, so Relay only would leave it unreachable.");
    });
    const { unmount } = render(<MachinePageHosting name="dev-server" client={refusing.rpc} connected manage />);
    fireEvent.click(within(await screen.findByRole("radiogroup")).getByRole("radio", { name: "Relay only" }));
    expect((await screen.findByRole("alert")).textContent).toContain("would leave it unreachable");
    expect(screen.getByTestId("machine-hosting").dataset.listen).toBe("lan");
    unmount();
    render(<MachinePageHosting name="dev-server" client={refusing.rpc} connected manage={false} />);
    await screen.findByTestId("machine-hosting");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("says so for an older runtime, and waits for a connection", async () => {
    const older = client({ name: "dev-server" });
    const { unmount } = render(<MachinePageHosting name="dev-server" client={older.rpc} connected manage />);
    expect((await screen.findByText("dev-server runs a TerminalX that does not say where it listens.")).tagName).toBe("P");
    unmount();
    render(<MachinePageHosting name="dev-server" client={null} connected={false} manage />);
    expect(screen.getByText("Shown once dev-server is connected.")).toBeTruthy();
  });
});
