import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, workspaceConnection } from "@/lib/api";
import { CloudSessionPage } from "./CloudSessionPage";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
vi.mock("@/lib/api", () => ({
  api: { cloudWorkspaces: vi.fn() },
  workspaceConnection: vi.fn(),
  devWorkspaceConnection: vi.fn(),
}));

const workspace = (id: string, state: string) => ({
  workspace: { id, orgId: "org-1", name: `Workspace ${id}`, provider: "box", state, accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null },
  latestOperation: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.cloudWorkspaces).mockResolvedValue({
    workspaces: [workspace("ws-ready", "ready"), workspace("ws-asleep", "suspended"), workspace("ws-new", "provisioning")],
  } as never);
  vi.mocked(workspaceConnection).mockResolvedValue(fakeConnection() as never);
});

const stateListeners = new Set<(state: unknown) => void>();
const mutate = vi.fn(async () => ({ ptyId: "remote-pty-1" }));
const fakeConnection = () => ({
  target: { kind: "cloud", organizationId: "org-1", workspaceId: "ws-ready" },
  client: {
    onState: (listener: (state: unknown) => void) => {
      stateListeners.add(listener);
      listener({ state: "connecting", attempt: 0 });
      return () => stateListeners.delete(listener);
    },
    mutate,
    attachPty: vi.fn(async () => () => undefined),
    call: vi.fn(async () => ({})),
    write: vi.fn(async () => true),
    subscribeSession: vi.fn(async () => () => undefined),
  },
  activate: vi.fn(),
  close: vi.fn(),
});
const emit = (state: unknown) => {
  for (const listener of [...stateListeners]) listener(state);
};
const connectedState = { state: "connected", runtimeGeneration: 7, runtimeVersion: "0.2.2", capabilities: ["pty/1"], authority: "manage" };

afterEach(cleanup);

describe("cloud workspace session page", () => {
  it("connects a ready workspace without waking compute", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    const [openReady] = await screen.findAllByRole("button", { name: "Open session" });
    fireEvent.click(openReady!);
    await waitFor(() =>
      expect(workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-ready" }, "connect"),
    );
    await waitFor(() => expect(screen.getByTestId("cloud-connection-state").textContent).toBe("Connecting…"));
  });

  it("wakes a suspended workspace only from the explicit resume action", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume and open" }));
    await waitFor(() =>
      expect(workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-asleep" }, "wake"),
    );
  });

  it("creates the remote terminal once connected and keeps it across a reconnect", async () => {
    stateListeners.clear();
    mutate.mockClear();
    render(<CloudSessionPage onBack={() => undefined} />);
    const [openReady] = await screen.findAllByRole("button", { name: "Open session" });
    fireEvent.click(openReady!);
    await screen.findByTestId("cloud-terminal");
    expect(mutate).not.toHaveBeenCalled();
    emit(connectedState);
    await waitFor(() => expect(mutate).toHaveBeenCalledWith("pty.create", { cols: 80, rows: 24 }));
    emit({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 });
    emit(connectedState);
    fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: /Terminal/ }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("does not offer a session for a workspace that is still provisioning", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    const buttons = await screen.findAllByRole("button", { name: "Open session" });
    expect((buttons.at(-1) as HTMLButtonElement).disabled).toBe(true);
  });
});
