import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalVmState } from "@/types/localVm";
import { environment } from "@/components/localVm/localVm.testSupport";
import { setupReadiness, setupReport } from "@/components/localVm/setup.testSupport";
import { environmentComputer } from "@/types/computer";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), state: null as LocalVmState | null }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("@/components/localVm/useLocalVmState", () => ({ useLocalVmState: () => ({ state: mocks.state, error: null }), reconcileLocalVmState: vi.fn() }));
import { LinuxComputerSetup } from "./LinuxComputerSetup";
const target = { kind: "linuxContainer" as const, runtime: "docker" as const, id: "a".repeat(64) };
beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.state = { enabled: true, tasks: {}, environments: {} }; });
afterEach(cleanup);

it("shows the missing runtime gate without installation, enrollment or login effects", () => {
  render(<LinuxComputerSetup target={target} />);
  expect(screen.getByText(/No verified task runtime profile/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in to Codex" })).toBeNull();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("requires an inspected exact-container receipt and human confirmation before reconciliation", async () => {
  mocks.invoke.mockImplementation(async (_command, { method }) => ({ target, status: method === "computer.attachment" ? "releaseAvailable" : "released", markerDigest: "receipt", detail: "Container has exited" }));
  render(<LinuxComputerSetup target={target} />);
  expect(screen.queryByRole("button", { name: "Reconcile confirmed container exit" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Inspect desktop ownership" }));
  const reconcile = await screen.findByRole("button", { name: "Reconcile confirmed container exit" });
  expect(reconcile.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(reconcile);
  await screen.findByText(/previous desktop action outcome remains unknown/);
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.reconcileAttachment", params: { target, markerDigest: "receipt", confirm: true } });
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("never offers a release for fenced or mismatched evidence", async () => {
  mocks.invoke.mockResolvedValue({ target, status: "fenced", detail: "No exit proof" });
  render(<LinuxComputerSetup target={target} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect desktop ownership" }));
  await screen.findByText("No exit proof");
  expect(screen.queryByRole("checkbox")).toBeNull();
  mocks.invoke.mockResolvedValue({ target: { ...target, id: "b".repeat(64) }, status: "releaseAvailable", markerDigest: "other" });
  fireEvent.click(screen.getByRole("button", { name: "Inspect desktop ownership" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("routes explicit Codex login to the exact Linux generation and observes it after reopening", async () => {
  const env = { ...environment, transport: { ...target, runtimeSha256: "b".repeat(64) }, setup: setupReport({ taskMode: "shellFiles",
    steps: [{ id: "runtime", label: "Linux runtime", state: "complete" }, { id: "provider", label: "Guest Codex", state: "waiting", actionCode: "provider.codexDeviceLogin.start" }],
    readiness: setupReadiness({ provider: { harness: "codex", state: "unauthenticated", reasonCode: "login_required", actionCode: "provider.codexDeviceLogin.start", evidence: "localFileLoginStatus" } }) }) };
  env.setup.computer = environmentComputer(env);
  mocks.state!.environments = { env };
  mocks.invoke.mockResolvedValue({});
  const view = render(<LinuxComputerSetup target={target} />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.queryByText("Accessibility")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Complete the displayed sign-in yourself/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm setup action" }));
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([, args]) => args.method === "environment.setupAction")).toHaveLength(1));
  const request = mocks.invoke.mock.calls.find(([, args]) => args.method === "environment.setupAction")![1];
  expect(request).toMatchObject({ method: "environment.setupAction", params: { environmentId: env.id, generation: env.generation, action: "provider.codexDeviceLogin.start", confirm: true } });
  view.unmount();
  mocks.invoke.mockClear();
  mocks.invoke.mockResolvedValue({ protocol: 1, environmentId: env.id, generation: env.generation, idempotencyKey: request.params.idempotencyKey, status: "awaitingUser", challenge: { verificationUrl: "https://auth.openai.com/codex/device", userCode: "ONE-TIME", loginId: "owned-login" } });
  render(<LinuxComputerSetup target={target} />);
  await screen.findByText("ONE-TIME");
  expect(mocks.invoke.mock.calls.every(([, args]) => args.method === "environment.setupAuth")).toBe(true);
  expect(JSON.stringify(localStorage)).not.toContain("ONE-TIME");
});
