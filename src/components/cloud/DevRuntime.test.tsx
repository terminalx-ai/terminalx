import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PRO-68: the development runtime moved from the full-window cloud page to a
// debug-only Development section of the sidebar.

const mocks = vi.hoisted(() => ({ devWorkspaceConnection: vi.fn(), views: [] as { opened: { name: string; provider: string | null; workspaceState: string | null } }[] }));

vi.mock("@/lib/api", () => ({
  api: {},
  devWorkspaceConnection: mocks.devWorkspaceConnection,
  workspaceTargetKey: (target: { organizationId: string; workspaceId: string }) => `cloud:${target.organizationId}:${target.workspaceId}`,
}));
vi.mock("@/lib/cloudTerminals", () => ({
  detachCloudTerminals: vi.fn(),
  errorCode: (error: unknown) => (error as { code?: string }).code ?? "unknown",
}));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/layout/cloud/CloudSections", async () => {
  const { useState } = await import("react");
  return { useSectionCollapsed: (_key: string, byDefault: boolean) => { const [collapsed, set] = useState(byDefault); return [collapsed, () => set((value: boolean) => !value)]; } };
});
vi.mock("./CloudWorkspaceView", () => ({
  ExecutionLocation: () => <span data-testid="cloud-execution-location" />,
  describe: (state: { state: string }) => state.state,
  WorkspaceView: (props: { opened: { name: string; provider: string | null; workspaceState: string | null } }) => {
    mocks.views.push(props);
    return <div data-testid="workspace-view" />;
  },
}));

const { DevelopmentSection, DevRuntimeMain } = await import("./DevRuntime");
const dev = await import("@/lib/devRuntime");
const sessions = await import("@/lib/sessions");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const connection = () => ({
  target: { kind: "cloud", organizationId: "dev", workspaceId: "dev:1" },
  client: { onState: (listener: (state: unknown) => void) => (listener({ state: "connecting" }), () => undefined) },
  activate: vi.fn(),
  close: vi.fn(),
});

const mount = () =>
  render(
    <TooltipProvider>
      <div role="tree">
        <DevelopmentSection />
      </div>
      <DevRuntimeMain sidebarOpen onToggleSidebar={() => undefined} />
    </TooltipProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.views.length = 0;
  dev.setDevRuntimeAvailable(true);
});

afterEach(() => {
  cleanup();
  act(() => dev.detachDevRuntime());
  dev.setDevRuntimeAvailable(false);
  act(() => sessions.selectCloudWorkspace(null));
});

describe("the Development section", () => {
  it("is absent outside a debug build, and attaching is refused", async () => {
    dev.setDevRuntimeAvailable(false);
    mount();
    expect(screen.queryByTestId("dev-runtime-section")).toBeNull();
    await expect(dev.attachDevRuntime("code")).rejects.toMatchObject({ code: "dev_runtime_unavailable" });
    expect(mocks.devWorkspaceConnection).not.toHaveBeenCalled();
  });

  it("attaches to a development runtime by pairing code and shows it in the main slot", async () => {
    const attached = connection();
    mocks.devWorkspaceConnection.mockResolvedValue(attached);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand Development" }));
    const attach = screen.getByRole("button", { name: /Attach/ }) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "  pair-me  " } });
    fireEvent.click(attach);
    await waitFor(() => expect(mocks.devWorkspaceConnection).toHaveBeenCalledWith("pair-me"));
    await screen.findByTestId("workspace-view");
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(dev.DEV_RUNTIME_KEY);
    expect(mocks.views.at(-1)!.opened).toMatchObject({ name: "Development runtime", provider: null, workspaceState: null });
    expect(screen.getByTestId("cloud-connection-state").textContent).toBe("connecting");

    // Disconnecting closes it and leaves the main slot.
    fireEvent.click(screen.getByRole("button", { name: "Disconnect the development runtime" }));
    expect(attached.close).toHaveBeenCalledTimes(1);
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
    expect(screen.queryByTestId("workspace-view")).toBeNull();
  });

  it("says why an attach failed and keeps the code to try again", async () => {
    mocks.devWorkspaceConnection.mockRejectedValue(Object.assign(new Error("no"), { code: "pairing_code_invalid" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Expand Development" }));
    fireEvent.change(screen.getByLabelText("Pairing code"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /Attach/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not attach: pairing_code_invalid");
    expect((screen.getByLabelText("Pairing code") as HTMLInputElement).value).toBe("bad");
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
  });
});
