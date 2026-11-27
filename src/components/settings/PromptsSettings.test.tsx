import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus } from "@/lib/api";
import { getPrefs, setPrefs } from "@/lib/prefs";

const { role, invoke, showError } = vi.hoisted(() => ({ role: { value: "owner" }, invoke: vi.fn(), showError: vi.fn() }));
function account() {
  return {
    status: {
      state: "signed-in",
      identity: { organizationId: "org-a" },
      organizations: [{ id: "org-a", name: "Fixture Labs", role: role.value, isPersonal: false }],
      phase2Readiness: { "org-a": ["team.shared-setups.v1"] },
    } as unknown as AccountStatus,
  };
}
vi.mock("@/lib/account", () => ({ getAccount: account, useAccount: account }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/errorToasts", () => ({ showError }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => (id: string) => (id === "u-1" ? "Aisha Khan" : id) }));

const { PromptsSettings } = await import("./PromptsSettings");

const prompt = (body: string, revision: number) => ({ body, updatedBy: "u-1", updatedAt: new Date().toISOString(), revision });

afterEach(() => {
  cleanup();
  invoke.mockReset();
  showError.mockReset();
  role.value = "owner";
  setPrefs({ actionPrompts: {}, fixErrorsInstructions: "" });
});

describe("Settings › Prompts", () => {
  it("has one tab per layer, the six actions in each, and keeps personal prompts on this computer", async () => {
    invoke.mockResolvedValue({ canEdit: true, prompts: {} });
    render(<PromptsSettings />);
    expect(screen.getByRole("tab", { name: "Personal" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("tab", { name: "Fixture Labs · shared" });
    for (const title of ["General instructions", "Review", "Create pull request", "Fix failing checks", "Resolve conflicts", "Branch names"])
      expect(screen.getByRole("button", { name: new RegExp(title) })).toBeTruthy();
    expect(screen.getByText("Added to your chats after Fixture Labs’ shared prompts. Only you see these.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "General instructions" }), { target: { value: "Prefer small commits." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(getPrefs().actionPrompts.general).toBe("Prefer small commits.");
    expect(invoke).not.toHaveBeenCalledWith("shared_setups", expect.objectContaining({ op: expect.objectContaining({ op: "savePrompt" }) }));
  });

  it("saves the organization's prompt with the revision it read, and shows a newer one on a conflict", async () => {
    invoke.mockImplementation((_command: string, { op }: { op: { op: string } }) => {
      if (op.op === "listPrompts") return Promise.resolve({ canEdit: true, prompts: { general: prompt("Use pnpm.", 3) } });
      return Promise.reject({ code: "action_prompt_conflict" });
    });
    render(<PromptsSettings />);
    fireEvent.click(await screen.findByRole("tab", { name: "Fixture Labs · shared" }));
    await screen.findByText("Set by Fixture Labs");
    expect(screen.getByText(/Last edited by Aisha Khan/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "General instructions" }), { target: { value: "Use bun." } });
    fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("shared_setups", { orgId: "org-a", op: { op: "savePrompt", action: "general", body: "Use bun.", revision: 3 } });
    expect(showError.mock.calls[0]![2].title).toBe("Not saved");
    // The newer version beside the text typed here, neither lost.
    expect(screen.getByText("Saved by someone else meanwhile")).toBeTruthy();
    expect(screen.getByTestId("newer-prompt").textContent).toBe("Use pnpm.");
    expect((screen.getByRole("textbox", { name: "General instructions" }) as HTMLTextAreaElement).value).toBe("Use bun.");
  });

  it("says so when the newer version cannot be loaded after a conflict, and keeps the text", async () => {
    let lists = 0;
    invoke.mockImplementation((_command: string, { op }: { op: { op: string } }) => {
      if (op.op === "listPrompts") return ++lists === 1 ? Promise.resolve({ canEdit: true, prompts: { general: prompt("Use pnpm.", 3) } }) : Promise.reject(new Error("offline"));
      return Promise.reject({ code: "action_prompt_conflict" });
    });
    render(<PromptsSettings />);
    fireEvent.click(await screen.findByRole("tab", { name: "Fixture Labs · shared" }));
    await screen.findByText("Set by Fixture Labs");
    fireEvent.change(screen.getByRole("textbox", { name: "General instructions" }), { target: { value: "Use bun." } });
    fireEvent.click(screen.getByRole("button", { name: "Save for everyone" }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(showError.mock.calls[0]![0]).toContain("couldn't be loaded");
    expect((screen.getByRole("textbox", { name: "General instructions" }) as HTMLTextAreaElement).value).toBe("Use bun.");
  });

  it("shows members the organization's prompts read-only", async () => {
    role.value = "member";
    invoke.mockResolvedValue({ canEdit: false, prompts: { createPr: prompt("Title PRs as PRO-123.", 1) } });
    render(<PromptsSettings />);
    fireEvent.click(await screen.findByRole("tab", { name: "Fixture Labs · shared" }));
    expect(await screen.findByText(/Only owners and admins can edit/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Create pull request/ }));
    expect((screen.getByRole("textbox", { name: "Create pull request" }) as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save for everyone" })).toBeNull();
  });
});
