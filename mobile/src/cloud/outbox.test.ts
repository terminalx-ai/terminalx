import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudCommand } from "./api";
import { b64, commandAad, open, receiptAad, seal, type CommandEnvelope } from "./crypto";
import { WorkspaceKeys } from "./keys";
import { CloudOutbox } from "./outbox";

const scope = { organizationId: "org-1", workspaceId: "ws-1" };
const key = new Uint8Array(randomBytes(32));

const command = (envelope: CommandEnvelope, state = "queued", fields: Partial<CloudCommand> = {}): CloudCommand => ({ clientCommandId: envelope.clientCommandId, tabId: envelope.tabId, kind: envelope.kind, state, keyId: envelope.keyId, createdAt: 1, updatedAt: 1, ...fields });

function receipt(envelope: CommandEnvelope, outcome: string, body: Record<string, unknown>, with_ = key, keyId = "k1") {
  const sealed = seal(with_, new Uint8Array(randomBytes(12)), new TextEncoder().encode(JSON.stringify({ v: 1, ...body })), receiptAad(scope.organizationId, scope.workspaceId, envelope.clientCommandId, outcome, keyId));
  return { resultIv: sealed.iv, resultCiphertext: sealed.ciphertext };
}

async function harness(options: { held?: boolean; blobs?: Map<string, string> } = {}) {
  const secrets = new Map<string, string>();
  const keys = new WorkspaceKeys(scope, { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) });
  if (options.held !== false) await keys.refresh({ call: (async () => ({ currentKeyId: "k1", keys: [{ keyId: "k1", key: b64(key), createdAt: 1, retiredAt: null }] })) as never });
  const blobs = options.blobs ?? new Map<string, string>();
  const storage = { getItem: async (name: string) => blobs.get(name) ?? null, setItem: async (name: string, value: string) => void blobs.set(name, value), removeItem: async (name: string) => void blobs.delete(name) };
  const posted: CommandEnvelope[] = [];
  const api = {
    enqueue: vi.fn(async (_org: string, _ws: string, envelope: CommandEnvelope) => {
      posted.push(envelope);
      return { command: command(envelope), existing: posted.filter((sent) => sent.clientCommandId === envelope.clientCommandId).length > 1, wake: "not-needed" as string | null };
    }),
    commandStatuses: vi.fn(async (_org: string, _ws: string, _ids: string[]): Promise<CloudCommand[]> => []),
    cancelCommand: vi.fn(async (_org: string, _ws: string, id: string) => command(posted.find((sent) => sent.clientCommandId === id)!, "cancelled")),
  };
  let clock = 1_000;
  const outbox = new CloudOutbox({ scope, api: api as never, keys, storage, now: () => clock++ });
  return { outbox, api, posted, blobs, keys, storage };
}

describe("the phone's command outbox", () => {
  it("seals a message once, keeps only the envelope, and posts it", async () => {
    const h = await harness();
    const entry = await h.outbox.enqueue("tab-1", "send", { text: "run the secret-tests" });
    expect(entry).toMatchObject({ tabId: "tab-1", kind: "send", text: "run the secret-tests", state: "queued", wake: "not-needed", error: null });
    expect(entry.clientCommandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(h.api.enqueue).toHaveBeenCalledWith("org-1", "ws-1", h.posted[0]);
    // What crossed the wire opens, with the bound metadata, to the versioned payload.
    const sent = h.posted[0];
    expect(JSON.parse(new TextDecoder().decode(open(key, sent.iv, sent.ciphertext, commandAad("org-1", "ws-1", "tab-1", sent.clientCommandId, "send", "k1"))))).toEqual({ text: "run the secret-tests", v: 1 });
    // Nothing of the message is on the phone in the clear.
    const stored = [...h.blobs.values()].join("");
    expect(stored).toContain(sent.ciphertext);
    expect(stored).not.toContain("secret-tests");
    expect(stored).not.toContain(b64(key));
  });

  it("writes the envelope to the phone before the request leaves", async () => {
    const h = await harness();
    let storedAtPost = "";
    h.api.enqueue.mockImplementationOnce(async (_org, _ws, envelope) => {
      storedAtPost = [...h.blobs.values()].join("");
      return { command: command(envelope), existing: false, wake: null };
    });
    const entry = await h.outbox.enqueue("tab-1", "send", { text: "hello" });
    expect(storedAtPost).toContain(entry.clientCommandId);
    expect(JSON.parse(storedAtPost).items[0].state).toBe("unsent");
  });

  it("keeps a message offline, and a later launch only reads: nothing is posted until delivery is allowed", async () => {
    const h = await harness();
    h.api.enqueue.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    const entry = await h.outbox.enqueue("tab-1", "send", { text: "while offline" });
    expect(entry).toMatchObject({ state: "unsent", error: "cloud_workspace_unavailable" });
    expect(h.outbox).toMatchObject({ pending: true, unsent: true, awaiting: false });

    // A new launch reads the outbox back. Looking posts nothing: a post to a
    // workspace that stopped meanwhile would start it.
    const again = await harness({ blobs: h.blobs });
    expect(await again.outbox.sync()).toBe(false);
    expect(await again.outbox.sync({ deliver: false })).toBe(false);
    expect(again.posted).toEqual([]);
    expect(again.outbox.entries()).toMatchObject([{ clientCommandId: entry.clientCommandId, text: "while offline", state: "unsent" }]);

    // Allowed (the workspace runs, or the person agreed to start it): the very same envelope goes out.
    expect(await again.outbox.sync({ deliver: true })).toBe(true);
    expect(again.posted).toHaveLength(1);
    expect(again.outbox.entries()).toMatchObject([{ clientCommandId: entry.clientCommandId, state: "queued", error: null }]);
    const first = JSON.parse([...h.blobs.values()][0]).items[0].envelope;
    expect(again.posted[0]).toEqual(first);
    // Delivered: not posted again.
    await again.outbox.sync({ deliver: true });
    expect(again.posted).toHaveLength(1);
  });

  it("can keep a command without posting it at all", async () => {
    const h = await harness();
    expect(await h.outbox.enqueue("tab-1", "send", { text: "later" }, { post: false })).toMatchObject({ state: "unsent", error: null });
    expect(h.api.enqueue).not.toHaveBeenCalled();
    expect([...h.blobs.values()].join("")).toContain("unsent");
  });

  it("takes a refusal as the answer and does not retry it", async () => {
    const h = await harness();
    h.api.enqueue.mockRejectedValueOnce(new CloudApiError("cloud_workspace_collaboration_forbidden", 403));
    expect(await h.outbox.enqueue("tab-1", "send", { text: "as a viewer" })).toMatchObject({ state: "rejected", category: "cloud_workspace_collaboration_forbidden" });
    await h.outbox.sync({ deliver: true });
    expect(h.api.enqueue).toHaveBeenCalledTimes(1);
    expect(h.outbox.pending).toBe(false);
  });

  it("reports what queueing did to the workspace's compute", async () => {
    const h = await harness();
    h.api.enqueue.mockImplementationOnce(async (_org, _ws, envelope) => ({ command: command(envelope), existing: false, wake: "queued" }));
    expect((await h.outbox.enqueue("tab-1", "send", { text: "wake up" })).wake).toBe("queued");
  });

  it("cannot seal without the workspace key, and posts nothing", async () => {
    const h = await harness({ held: false });
    await expect(h.outbox.enqueue("tab-1", "send", { text: "x" })).rejects.toMatchObject({ code: "no-key" });
    expect(h.api.enqueue).not.toHaveBeenCalled();
    expect(h.blobs.size).toBe(0);
  });

  it("follows a command to its receipt, opened with the workspace key and kept encrypted", async () => {
    const h = await harness();
    const entry = await h.outbox.enqueue("tab-1", "send", { text: "go" });
    h.api.commandStatuses.mockResolvedValueOnce([command(h.posted[0], "leased")]);
    expect(await h.outbox.sync()).toBe(true);
    expect(h.api.commandStatuses).toHaveBeenCalledWith("org-1", "ws-1", [entry.clientCommandId]);
    expect(h.outbox.entries()[0].state).toBe("leased");
    h.api.commandStatuses.mockResolvedValueOnce([command(h.posted[0], "applied", { outcomeCategory: "started", ...receipt(h.posted[0], "applied", { category: "started", note: "private-receipt-note" }) })]);
    await h.outbox.sync();
    expect(h.outbox.entries()[0]).toMatchObject({ state: "applied", category: "started", receipt: { outcome: "applied", note: "private-receipt-note" } });
    expect([...h.blobs.values()].join("")).not.toContain("private-receipt-note");
    expect(h.outbox.pending).toBe(false);
    // Settled: no longer asked about, and nothing changes.
    expect(await h.outbox.sync()).toBe(false);
    expect(h.api.commandStatuses).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer about another command or tab, an unknown state, and never un-settles", async () => {
    const h = await harness();
    await h.outbox.enqueue("tab-1", "send", { text: "go" });
    const sent = h.posted[0];
    h.api.commandStatuses.mockResolvedValueOnce([command({ ...sent, clientCommandId: "other" }, "applied"), command({ ...sent, tabId: "tab-9" }, "applied"), command(sent, "exploded")]);
    await h.outbox.sync();
    expect(h.outbox.entries()[0].state).toBe("queued");
    h.api.commandStatuses.mockResolvedValueOnce([command(sent, "rejected", { outcomeCategory: "tab-closed" })]);
    await h.outbox.sync();
    h.api.enqueue.mockImplementation(async (_org, _ws, envelope) => ({ command: command(envelope, "queued"), existing: true, wake: null }));
    expect(h.outbox.entries()[0]).toMatchObject({ state: "rejected", category: "tab-closed" });
  });

  it("decides a permission request once, whatever is tapped", async () => {
    const h = await harness();
    const [first, second] = await Promise.allSettled([h.outbox.enqueue("tab-1", "permission-decision", { requestId: "r1", optionId: "allow" }), h.outbox.enqueue("tab-1", "permission-decision", { requestId: "r1", optionId: "deny" })]);
    expect(first.status).toBe("fulfilled");
    // The second tap gets the first decision, not one of its own.
    expect(second).toMatchObject({ status: "fulfilled", value: { clientCommandId: (first as PromiseFulfilledResult<{ clientCommandId: string }>).value.clientCommandId } });
    expect(h.outbox.isDeciding("r1")).toBe(true);
    // A later tap gets the first decision back.
    const later = await h.outbox.enqueue("tab-1", "permission-decision", { requestId: "r1", optionId: "deny" });
    expect(later.clientCommandId).toBe((first as PromiseFulfilledResult<{ clientCommandId: string }>).value.clientCommandId);
    expect(h.posted).toHaveLength(1);
    expect(h.outbox.decisionFor("r1")).toMatchObject({ requestId: "r1", kind: "permission-decision" });
    // A request the runtime says is no longer pending was decided elsewhere: still no second decision.
    h.api.commandStatuses.mockResolvedValueOnce([command(h.posted[0], "rejected", { outcomeCategory: "request-not-pending" })]);
    await h.outbox.sync();
    expect(h.outbox.decisionFor("r1")).toMatchObject({ state: "rejected", category: "request-not-pending" });
    // One that was refused for another reason, or cancelled, may be decided again.
    const other = await h.outbox.enqueue("tab-1", "permission-decision", { requestId: "r3", optionId: "allow" });
    h.api.commandStatuses.mockResolvedValueOnce([command(h.posted[1], "rejected", { outcomeCategory: "tab-closed" })]);
    await h.outbox.sync();
    expect(other.requestId).toBe("r3");
    expect(h.outbox.decisionFor("r3")).toBeNull();
    expect(h.outbox.isDeciding("r2")).toBe(false);
  });

  it("cancels a queued command, and drops one that never left the phone", async () => {
    const h = await harness();
    const queued = await h.outbox.enqueue("tab-1", "send", { text: "one" });
    await h.outbox.cancel(queued.clientCommandId);
    expect(h.outbox.entries()[0].state).toBe("cancelled");

    h.api.enqueue.mockRejectedValueOnce(new CloudApiError("cloud_workspace_unavailable", null));
    const unsent = await h.outbox.enqueue("tab-1", "send", { text: "two" });
    h.api.cancelCommand.mockRejectedValueOnce(new CloudApiError("cloud_workspace_agent_command_not_found", 404));
    await h.outbox.cancel(unsent.clientCommandId);
    expect(h.outbox.entries()[1].state).toBe("cancelled");
    await h.outbox.sync({ deliver: true });
    expect(h.posted).toHaveLength(1);
  });

  it("shows no text for an entry whose key is gone, lists by tab, and clears", async () => {
    const h = await harness();
    await h.outbox.enqueue("tab-1", "send", { text: "one" });
    await h.outbox.enqueue("tab-2", "stop", {});
    expect(h.outbox.entries("tab-2")).toMatchObject([{ kind: "stop", text: null }]);
    await h.keys.clear();
    expect(h.outbox.entries("tab-1")).toMatchObject([{ text: null, state: "queued" }]);
    const seen = vi.fn();
    h.outbox.subscribe(seen);
    await h.outbox.clear();
    expect(h.outbox.entries()).toEqual([]);
    expect(h.blobs.size).toBe(0);
    expect(seen).toHaveBeenCalled();
  });
});
