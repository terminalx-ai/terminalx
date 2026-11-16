import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinuxInstallRecord } from "@/lib/localVm";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
import { LinuxRuntimeInstaller } from "./LinuxRuntimeInstaller";
const target = { kind: "linuxContainer" as const, runtime: "docker" as const, id: "a".repeat(64) };
const operation: LinuxInstallRecord = { requestKey: "original", inputDigest: "retained", status: "prepared", ready: false,
  intent: { profileId: "native", sourceCommit: "commit", runtimeSha256: "digest", binding: { target, environmentId: "environment", generation: "generation", architecture: "arm64",
    account: { name: "cua", uid: 1000, gid: 1000, home: "/home/cua", homeDevice: 1, homeInode: 2, architecture: "arm64" } } } };
const view = { target, available: true, profiles: [{ id: "native", architecture: "arm64", sourceCommit: "commit" }], operations: [operation], reason: "" };
beforeEach(() => { mocks.invoke.mockReset(); });
afterEach(cleanup);
it("keeps an empty trusted catalog unavailable and never operates a guest on mount", async () => {
  render(<LinuxRuntimeInstaller target={target} enabled />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValue({ ...view, available: false, profiles: [], operations: [], reason: "Native artifact proof missing." });
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  await screen.findByText(/Production installation is unavailable/);
  expect(screen.getByRole("button", { name: "Prepare verified Linux runtime" }).hasAttribute("disabled")).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("requires confirmation and sends the exact retained intent for delivery", async () => {
  mocks.invoke.mockResolvedValueOnce(view).mockResolvedValueOnce({ ...operation, status: "installed" });
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const install = await screen.findByRole("button", { name: "Install prepared runtime" });
  expect(install.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/UID 1000/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(install);
  await screen.findByText(/Guest runtime activation, Codex authorization and task readiness are still separate/);
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.deliverLinuxRuntime", params: { target, idempotencyKey: "original", inputDigest: "retained", confirm: true } });
});
it("reopens an unknown operation for receipt recovery without offering reinstall", async () => {
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [{ ...operation, status: "outcomeUnknown" }] }).mockResolvedValueOnce({ ...operation, status: "installed" });
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const recover = await screen.findByRole("button", { name: "Reconcile original installation" });
  expect(screen.queryByRole("button", { name: "Install prepared runtime" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(recover);
  await screen.findByText(/installer completion confirmed/);
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.reconcileLinuxRuntime", params: { target, idempotencyKey: "original", inputDigest: "retained", confirm: true } });
});
it("rejects target replacement and retains the original generation after mismatched recovery", async () => {
  mocks.invoke.mockResolvedValueOnce({ ...view, target: { ...target, id: "b".repeat(64) } });
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  await screen.findByRole("alert");expect(screen.queryByRole("checkbox")).toBeNull();
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [{ ...operation, status: "outcomeUnknown" }] }).mockResolvedValueOnce({ ...operation, status: "installed", intent: { ...operation.intent, binding: { ...operation.intent.binding, generation: "replacement" } } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const recover = await screen.findByRole("button", { name: "Reconcile original installation" });
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(recover);
  await screen.findByText(/Original installation identity changed/);
  expect(screen.queryByText(/Runtime files installed/)).toBeNull();
});

it("finishes interrupted host staging with the original key and no delivery call", async () => {
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [{ ...operation, status: "staging" }] }).mockResolvedValueOnce(operation);
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const resume = await screen.findByRole("button", { name: "Finish verified artifact staging" });
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(resume);
  await screen.findByRole("button", { name: "Install prepared runtime" });
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.prepareLinuxRuntime", params: { target, profileId: "native", idempotencyKey: "original", confirm: true } });
  expect(mocks.invoke.mock.calls.some(([, value]) => value.method === "computer.deliverLinuxRuntime")).toBe(false);
});

it("keeps activation disabled despite installed files and an available artifact catalog", async () => {
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [{ ...operation, status: "installed" }], activation: { available: false, reason: "Live supervision acceptance missing." } });
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const activate = await screen.findByRole("button", { name: "Activate installed runtime" });
  expect(activate.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Live supervision acceptance missing.")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("reopens an unknown activation with its original request and offers no second start", async () => {
  const unknown = { ...operation, status: "installed", activation: { id: "activation", status: "outcomeUnknown", ready: false } };
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [unknown], activation: { available: true, reason: "fixture only" } })
    .mockResolvedValueOnce({ ...unknown, activation: { ...unknown.activation, status: "owned" } });
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const recover = await screen.findByRole("button", { name: "Reconcile original activation" });
  expect(screen.queryByRole("button", { name: "Activate installed runtime" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Verify serving runtime and continue" })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(recover);
  await screen.findByRole("button", { name: "Verify serving runtime and continue" });
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.reconcileLinuxActivation", params: { target, idempotencyKey: "original", inputDigest: "retained", confirm: true } });
  expect(screen.queryByText(/account and artifact verified/)).toBeNull();
});
it("verifies enrollment identity before continuing to guest provider setup", async () => {
  const owned = { ...operation, status: "installed", activation: { id: "activation", status: "owned", ready: false } };
  const environment = { id: "environment", generation: "generation", transport: { kind: "linuxContainer", runtime: "docker", id: target.id, runtimeSha256: "digest" } };
  const onEnrolled = vi.fn().mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [owned], activation: { available: true, reason: "fixture only" } })
    .mockResolvedValueOnce({ ...owned, enrollment: { status: "verified", ready: false, environment: { ...environment, generation: "replaced" } } })
    .mockResolvedValueOnce({ ...owned, enrollment: { status: "verified", ready: false, environment } });
  render(<LinuxRuntimeInstaller target={target} enabled onEnrolled={onEnrolled} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const enroll = await screen.findByRole("button", { name: "Verify serving runtime and continue" });
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(enroll);
  await screen.findByText(/Serving enrollment returned a different/);
  expect(onEnrolled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(enroll);
  await screen.findByText(/enrollment alone is not Ready/);
  expect(onEnrolled).toHaveBeenCalledTimes(1);
  expect(mocks.invoke.mock.calls[2][1].method).toBe("computer.enrollInstalledLinuxRuntime");
});
it("keeps a changed activation response fenced and cancellation bound to the original request", async () => {
  const unknown = { ...operation, status: "installed", activation: { id: "activation", status: "outcomeUnknown", ready: false } };
  mocks.invoke.mockResolvedValueOnce({ ...view, operations: [unknown], activation: { available: true, reason: "fixture only" } })
    .mockResolvedValueOnce({ ...unknown, activation: { ...unknown.activation, id: "replacement", status: "stopped" } });
  render(<LinuxRuntimeInstaller target={target} enabled />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect runtime installation" }));
  const cancel = await screen.findByRole("button", { name: "Request original activation cancellation" });
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(cancel);
  await screen.findByText(/Original activation identity changed/);
  expect(screen.queryByText(/The original activation stopped/)).toBeNull();
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.cancelLinuxActivation", params: { target, idempotencyKey: "original", inputDigest: "retained", confirm: true } });
});
