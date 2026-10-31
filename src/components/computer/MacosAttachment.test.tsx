import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
import { MacosAttachment } from "./MacosAttachment";
const target = { kind: "macosGuest" as const, environmentId: "env", generation: "generation" };
const binding = { environmentId: "env", generation: "generation", leaseId: "lease", sessionId: "parent", tabId: "tab", conversation: "original" };
beforeEach(() => { mocks.invoke.mockReset(); });
afterEach(cleanup);
it("does not contact the guest on render and rejects capability evidence for a replacement", async () => {
  const checked = vi.fn();render(<MacosAttachment context={{ sessionId: "session", tabId: "tab", conversation: "conversation" }} target={target} onChecked={checked} />);
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValue({ target: { ...target, generation: "replacement" }, available: true, detail: "Wrong guest" });
  fireEvent.click(screen.getByRole("button", { name: "Check macOS desktop tools" }));
  await screen.findByRole("alert");expect(checked).not.toHaveBeenCalledWith(true);
  expect(mocks.invoke.mock.calls[0][1]).toEqual({ method: "computer.checkAttachment", params: { target, sessionId: "session", tabId: "tab", conversation: "conversation" } });
});
it("preserves fencing and never offers a force release", async () => {
  mocks.invoke.mockResolvedValue({ target, binding, status: "fenced", detail: "Unconfirmed guest connection exit" });
  render(<MacosAttachment context={{ sessionId: "session", tabId: "tab", conversation: "conversation" }} target={target} onChecked={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect retained attachment" }));
  await screen.findByText("Unconfirmed guest connection exit");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Release this retained attachment" })).toBeNull();
});
it("releases only the displayed retained parent binding after explicit confirmation", async () => {
  mocks.invoke.mockImplementation(async (_command, { method }) => ({ target, binding, status: method === "computer.attachment" ? "releaseAvailable" : "released", detail: method === "computer.attachment" ? "Proof available" : "Receipts retained" }));
  render(<MacosAttachment context={{ sessionId: "session", tabId: "tab", conversation: "conversation" }} target={target} onChecked={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect retained attachment" }));
  const release = await screen.findByRole("button", { name: "Release this retained attachment" });
  expect(release.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Conversation original/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(release);
  await screen.findByText("Receipts retained");
  expect(mocks.invoke.mock.calls[1][1]).toEqual({ method: "computer.reconcileAttachment", params: { target, binding, confirm: true } });
});
