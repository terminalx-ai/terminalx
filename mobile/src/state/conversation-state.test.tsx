// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evictConversationKey,
  forgetConversationState,
  hasRetainedConversationKey,
  MAX_RETAINED_HEAVY_TABS,
  setConversationState,
  useConversationState,
} from "./conversation-state";

describe("conversation-state LRU and unmount eviction (P-48)", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetConversationState("");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    forgetConversationState("");
    container.remove();
  });

  it("evicts oldest inactive tabs' heavy keys once MAX_RETAINED_HEAVY_TABS is exceeded while keeping drafts", () => {
    const totalTabs = MAX_RETAINED_HEAVY_TABS + 3;
    for (let i = 0; i < totalTabs; i++) {
      const prefix = `host:session:tab-${i}`;
      setConversationState(`${prefix}:events`, [{ seq: i }]);
      setConversationState(`${prefix}:notes`, [{ id: `n-${i}` }]);
      setConversationState(`${prefix}:attachments`, [{ id: `a-${i}`, data: "big" }]);
      setConversationState(`${prefix}:draft`, `draft-${i}`);
    }

    // Oldest 3 tabs' heavy keys were evicted, while their lightweight drafts remain.
    for (let i = 0; i < 3; i++) {
      const prefix = `host:session:tab-${i}`;
      expect(hasRetainedConversationKey(`${prefix}:events`)).toBe(false);
      expect(hasRetainedConversationKey(`${prefix}:notes`)).toBe(false);
      expect(hasRetainedConversationKey(`${prefix}:attachments`)).toBe(false);
      expect(hasRetainedConversationKey(`${prefix}:draft`)).toBe(true);
    }

    // Most recent MAX_RETAINED_HEAVY_TABS tabs are retained.
    for (let i = 3; i < totalTabs; i++) {
      const prefix = `host:session:tab-${i}`;
      expect(hasRetainedConversationKey(`${prefix}:events`)).toBe(true);
      expect(hasRetainedConversationKey(`${prefix}:notes`)).toBe(true);
      expect(hasRetainedConversationKey(`${prefix}:attachments`)).toBe(true);
    }
  });

  it("never evicts an actively subscribed tab and evicts :events on unmount via evictConversationKey", async () => {
    function ActiveTab({ prefix }: { prefix: string }) {
      const [events] = useConversationState<number[]>(`${prefix}:events`, [1, 2, 3]);
      return <div>{events.length}</div>;
    }

    const activePrefix = "host:session:active";
    await act(async () => root.render(<ActiveTab prefix={activePrefix} />));
    expect(hasRetainedConversationKey(`${activePrefix}:events`)).toBe(true);

    // Fill well past the LRU limit with inactive tabs.
    for (let i = 0; i < MAX_RETAINED_HEAVY_TABS + 4; i++) {
      setConversationState(`host:session:bg-${i}:events`, [i]);
    }
    // Actively mounted tab must still be retained.
    expect(hasRetainedConversationKey(`${activePrefix}:events`)).toBe(true);

    // Request eviction while still mounted, then unmount -> evicted synchronously as subscriber leaves.
    evictConversationKey(`${activePrefix}:events`);
    expect(hasRetainedConversationKey(`${activePrefix}:events`)).toBe(true);
    await act(async () => root.unmount());
    expect(hasRetainedConversationKey(`${activePrefix}:events`)).toBe(false);
  });
});
