import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { getPrefs, setPrefs } from "@/lib/prefs";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
function account() {
  return {
    status: {
      state: "signed-in",
      identity: { organizationId: "org-a" },
      organizations: [{ id: "org-a", name: "Fixture Labs", role: "member", isPersonal: false }],
      phase2Readiness: { "org-a": ["team.shared-setups.v1"] },
    } as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { SaveSnippetDialog } = await import("@/components/chat/SaveSnippetDialog");
const { SnippetManager } = await import("./SnippetManager");

const shared = { id: "s-1", name: "review", keyword: "review", body: "Review this diff for bugs first.", createdBy: "u-1", updatedBy: "u-1", updatedAt: "2026-11-27T00:00:00Z" };

function serve(snippets: (typeof shared & { mine?: boolean })[] = [shared]) {
  invoke.mockImplementation((_command: string, { op }: { op: { op: string } }) => {
    if (op.op === "listSnippets") return Promise.resolve({ snippets });
    if (op.op === "listPrompts") return Promise.resolve({ canEdit: false, prompts: {} });
    if (op.op === "createSnippet") return Promise.resolve({ ...shared, id: "s-2" });
    return Promise.resolve({});
  });
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  setPrefs({ promptSnippets: [] });
});

describe("snippet scope", () => {
  it("saves a snippet for everyone at the organization, not on this computer", async () => {
    serve();
    const onClose = vi.fn();
    render(<SaveSnippetDialog prompt="Write release notes." onClose={onClose} />);
    fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "relnotes" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Visible to" }), { target: { value: "org" } });
    expect(screen.getByText("Shows in every member’s picker. You and admins can change or delete it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("shared_setups", { orgId: "org-a", op: { op: "createSnippet", snippet: { name: "relnotes", keyword: "relnotes", body: "Write release notes." } } });
    expect(getPrefs().promptSnippets).toEqual([]);
  });

  it("lists a teammate's organization snippet beside your own, filtered by scope", async () => {
    serve();
    setPrefs({ promptSnippets: [{ id: "mine", name: "tidy", text: "Tidy the commit history." }] });
    render(<SnippetManager />);
    expect(await screen.findByText("/review")).toBeTruthy();
    expect(screen.getByText("/tidy")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Only me 1" }));
    expect(screen.queryByText("/review")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Everyone at Fixture Labs 1" }));
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.queryByText("/tidy")).toBeNull();
  });

  it("lets only the creator delete a shared snippet, after asking", async () => {
    serve([shared, { ...shared, id: "s-mine", keyword: "mine", createdBy: "u-me", mine: true }]);
    render(<SnippetManager />);
    await screen.findByText("/mine");
    expect(screen.queryByRole("button", { name: "Delete /review from Fixture Labs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete /mine from Fixture Labs" }));
    expect(screen.getByText("Delete for everyone?")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("shared_setups", expect.objectContaining({ op: expect.objectContaining({ op: "deleteSnippet" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("shared_setups", { orgId: "org-a", op: { op: "deleteSnippet", id: "s-mine" } }));
  });
});
