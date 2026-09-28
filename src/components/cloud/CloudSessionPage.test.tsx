import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, workspaceConnection } from "@/lib/api";
import { CloudSessionPage } from "./CloudSessionPage";

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));
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
  vi.mocked(workspaceConnection).mockResolvedValue({
    target: { kind: "cloud", organizationId: "org-1", workspaceId: "ws-ready" },
    client: { onState: (listener: (state: unknown) => void) => (listener({ state: "connecting", attempt: 0 }), () => undefined) },
    activate: vi.fn(),
    close: vi.fn(),
  } as never);
});

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

  it("does not offer a session for a workspace that is still provisioning", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    const buttons = await screen.findAllByRole("button", { name: "Open session" });
    expect((buttons.at(-1) as HTMLButtonElement).disabled).toBe(true);
  });
});
