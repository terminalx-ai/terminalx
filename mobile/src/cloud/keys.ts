import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { keyFromB64, sha256Hex, type CommandScope } from "./crypto";

/**
 * The workspace content keys this phone holds (contract §13). The runtime
 * hands them over the end-to-end encrypted channel (`keys.get`) only to
 * someone the workspace is shared with; the server never has them. They are
 * kept in the device's secure store, one item per workspace, and nowhere
 * else. A key the runtime no longer lists is deleted here too: after a
 * rotation (someone lost access) an old key opens nothing new.
 */

export interface SecretStorage {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface HeldKey {
  keyId: string;
  key: Uint8Array;
  createdAt: number;
  retiredAt: number | null;
}

interface Stored {
  v: 1;
  currentKeyId: string | null;
  keys: { keyId: string; key: string; createdAt: number; retiredAt: number | null }[];
}

/** SecureStore names take letters, digits, `.`, `-` and `_` only. */
export function keyItemName(scope: CommandScope): string {
  return `terminalx.cloud.keys.v1.${sha256Hex(new TextEncoder().encode(`${scope.organizationId}\0${scope.workspaceId}`)).slice(0, 40)}`;
}

export class WorkspaceKeys {
  private currentKeyId: string | null = null;
  private keys = new Map<string, HeldKey>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly scope: CommandScope,
    private readonly storage: SecretStorage,
  ) {}

  /** Read what the secure store holds, once. */
  load(): Promise<void> {
    return (this.loaded ??= (async () => {
      const raw = await this.storage.get(keyItemName(this.scope)).catch(() => null);
      if (!raw) return;
      try {
        this.take(JSON.parse(raw) as Stored);
      } catch {
        // Unreadable: as if none were held; the next connection fetches them again.
        this.keys.clear();
        this.currentKeyId = null;
      }
    })());
  }

  /** The key new commands are sealed under; null until this phone has been handed one. */
  current(): HeldKey | null {
    return this.currentKeyId ? (this.keys.get(this.currentKeyId) ?? null) : null;
  }

  get(keyId: string): HeldKey | null {
    return this.keys.get(keyId) ?? null;
  }

  /** The current key first, then the others: the order in which a receipt is tried. */
  all(): HeldKey[] {
    const current = this.current();
    return [...(current ? [current] : []), ...[...this.keys.values()].filter((held) => held !== current)];
  }

  /**
   * Ask the connected runtime for the keys (`keys/1`). It refuses someone
   * with no role; that leaves what is held untouched and is reported.
   */
  async refresh(client: Pick<WorkspaceRpcClient, "call">): Promise<void> {
    await this.load();
    const answer = (await client.call("keys.get", {})) as { currentKeyId?: unknown; keys?: unknown };
    if (typeof answer?.currentKeyId !== "string" || !Array.isArray(answer.keys)) throw new Error("keys.get answered in no known shape");
    const stored: Stored = { v: 1, currentKeyId: answer.currentKeyId, keys: [] };
    for (const entry of answer.keys as Record<string, unknown>[]) {
      if (typeof entry?.keyId !== "string" || typeof entry.key !== "string") continue;
      // Checked before it is kept: a key is 32 bytes.
      keyFromB64(entry.key);
      stored.keys.push({ keyId: entry.keyId, key: entry.key, createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0, retiredAt: typeof entry.retiredAt === "number" ? entry.retiredAt : null });
    }
    if (!stored.keys.some((entry) => entry.keyId === stored.currentKeyId)) throw new Error("keys.get named a current key it did not send");
    // Exactly the runtime's list: a key it dropped is dropped here.
    this.take(stored);
    await this.storage.set(keyItemName(this.scope), JSON.stringify(stored));
  }

  /** Forget every key of this workspace (deleted, access removed, signed out). */
  async clear(): Promise<void> {
    this.keys.clear();
    this.currentKeyId = null;
    this.loaded = Promise.resolve();
    await this.storage.delete(keyItemName(this.scope)).catch(() => undefined);
  }

  private take(stored: Stored): void {
    const next = new Map<string, HeldKey>();
    for (const entry of stored.keys ?? []) next.set(entry.keyId, { keyId: entry.keyId, key: keyFromB64(entry.key), createdAt: entry.createdAt, retiredAt: entry.retiredAt });
    this.keys = next;
    this.currentKeyId = stored.currentKeyId && next.has(stored.currentKeyId) ? stored.currentKeyId : null;
  }
}
