import { expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/lib/dialogs", () => ({ openSessionDelete: mocks.open }));
import { confirmDeleteSession } from "./deleteSessionFlow";
it("routes session deletion to the shared removal dialog", async () => {
  await confirmDeleteSession({ id: "s1", projectPath: "/p", cwd: "/p/wt", title: "Fix login" } as SessionEntry);
  expect(mocks.open).toHaveBeenCalledWith("/p", "/p/wt", "Fix login", "s1");
});
