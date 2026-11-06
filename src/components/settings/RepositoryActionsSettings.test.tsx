import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleActions, type RepositoryAction } from "@/lib/repositoryActions";
import { RepositoryActionsSettings } from "./RepositoryActionsSettings";

afterEach(cleanup);
const dev: RepositoryAction = { id: "dev", name: "Dev", icon: "play", command: "pnpm dev", concurrent: false, runAfterSetup: false, hidden: false };
const test: RepositoryAction = { ...dev, id: "test", name: "Test", command: "pnpm test" };
const edit = (label: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });

function Editor({ initial = [dev, test], save = async () => {}, reset }: {
  initial?: RepositoryAction[];
  save?: (next: RepositoryAction[]) => Promise<void>;
  reset?: RepositoryAction[];
}) {
  const [actions, setActions] = useState(initial);
  return <RepositoryActionsSettings actions={actions} onChange={async (next) => { await save(next); setActions(next); }} onReset={reset ? async () => { await save(reset); setActions(reset); } : undefined} />;
}

describe("repository action editor", () => {
  it("adds a multiline command, selected icon and switches using Command+Enter", async () => {
    const save = vi.fn(async () => {});
    render(<Editor initial={[]} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    edit("Name", "  Develop  ");
    const command = "  echo ready\npnpm dev\n";
    edit("Command", command);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "rocket" } });
    fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
    fireEvent.click(screen.getByRole("switch", { name: "Run after setup" }));
    fireEvent.click(screen.getByRole("switch", { name: "Allow several at once" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Command" }), { key: "Enter", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledExactlyOnceWith([{ id: expect.any(String), name: "Develop", command, icon: "rocket", concurrent: true, runAfterSetup: true, hidden: false }]);
    expect(screen.getByRole("button", { name: "Edit Develop" })).toBeTruthy();
  });

  it("shows inline required and duplicate-name errors, including names of hidden actions", async () => {
    const save = vi.fn(async () => {});
    render(<Editor initial={[{ ...dev, hidden: true }]} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    expect(screen.getAllByRole("alert").map((entry) => entry.textContent)).toEqual(["Enter a name.", "Enter a command."]);
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(document.getElementById(name.getAttribute("aria-describedby")!)?.textContent).toBe("Enter a name.");
    edit("Name", " dev ");
    edit("Command", "echo ok");
    expect(screen.getByRole("alert").textContent).toBe("Choose a unique name.");
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    expect(save).not.toHaveBeenCalled();
    edit("Name", "Lint");
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits in place, preserving hidden state and an unknown icon", async () => {
    const save = vi.fn(async () => {});
    render(<Editor initial={[dev, { ...test, hidden: true, icon: "future-icon" }]} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Test" }));
    edit("Command", "pnpm test --run");
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith([dev, { ...test, hidden: true, icon: "future-icon", command: "pnpm test --run" }]);
  });

  it("hides, shows and reorders the same list used to select the default visible action", async () => {
    const saved: RepositoryAction[][] = [];
    render(<Editor save={async (next) => { saved.push(next); }} />);
    expect(screen.getByRole("button", { name: "Move Dev up" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Move Test down" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Move Test up" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Saved actions" })).getAllByRole("listitem")[0].textContent).toContain("Test"));
    expect(visibleActions(saved.at(-1)!)[0].id).toBe("test");
    fireEvent.click(screen.getByRole("button", { name: "Hide Test" }));
    await screen.findByRole("button", { name: "Show Test" });
    expect(visibleActions(saved.at(-1)!).map((entry) => entry.id)).toEqual(["dev"]);
    fireEvent.click(screen.getByRole("button", { name: "Show Test" }));
    await screen.findByRole("button", { name: "Hide Test" });
    expect(visibleActions(saved.at(-1)!)[0].id).toBe("test");
  });

  it("keeps a failed save editable and prevents duplicate writes or dismissal while saving", async () => {
    let reject: (error: Error) => void = () => {};
    const save = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
    render(<Editor save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    edit("Command", "echo changed");
    const command = screen.getByRole("textbox", { name: "Command" });
    fireEvent.keyDown(command, { key: "Enter", metaKey: true });
    fireEvent.keyDown(command, { key: "Enter", metaKey: true });
    fireEvent.keyDown(command, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(command.matches(":disabled")).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Could not write repository settings.")));
    expect(screen.getByRole("alert").textContent).toBe("Could not write repository settings.");
    expect((command as HTMLTextAreaElement).value).toBe("echo changed");
    save.mockImplementation(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("cancels drafts and starts fresh on reopening; ordinary and composing Enter do not save", () => {
    const save = vi.fn(async () => {});
    render(<Editor save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    edit("Command", "unsaved");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Command" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Command" }), { key: "Enter", metaKey: true, isComposing: true });
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    expect((screen.getByRole("textbox", { name: "Command" }) as HTMLTextAreaElement).value).toBe(dev.command);
  });

  it("deletes and resets through the parent, and reports a failed reset without losing the list", async () => {
    const save = vi.fn(async () => {});
    render(<Editor save={save} reset={[dev]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Dev" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Edit Dev" })).toBeNull());
    save.mockRejectedValueOnce(new Error("Repository file is unreadable."));
    fireEvent.click(screen.getByRole("button", { name: "Reset to repository file" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Repository file is unreadable.");
    expect(screen.getByRole("button", { name: "Edit Test" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset to repository file" }));
    await screen.findByRole("button", { name: "Edit Dev" });
    expect(screen.queryByRole("button", { name: "Edit Test" })).toBeNull();
  });

  it("does not offer repository-file reset without a repository source", () => {
    render(<Editor />);
    expect(screen.queryByRole("button", { name: "Reset to repository file" })).toBeNull();
  });

  it("refuses to save an action that was deleted while the dialog was open", async () => {
    const save = vi.fn(async () => {});
    const { rerender } = render(<RepositoryActionsSettings actions={[dev]} onChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    rerender(<RepositoryActionsSettings actions={[]} onChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This action was removed. Close the dialog and add it again.");
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves an external visibility change while saving the command draft", async () => {
    const save = vi.fn(async () => {});
    const { rerender } = render(<RepositoryActionsSettings actions={[dev]} onChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Dev" }));
    edit("Command", "pnpm dev --host");
    rerender(<RepositoryActionsSettings actions={[{ ...dev, hidden: true }]} onChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).toHaveBeenCalledWith([{ ...dev, hidden: true, command: "pnpm dev --host" }]);
  });

  it("revalidates against names added while the dialog is open", () => {
    const save = vi.fn(async () => {});
    const { rerender } = render(<RepositoryActionsSettings actions={[dev]} onChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    edit("Name", "Test");
    edit("Command", "pnpm test");
    rerender(<RepositoryActionsSettings actions={[dev, test]} onChange={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));
    expect(screen.getByRole("alert").textContent).toBe("Choose a unique name.");
    expect(save).not.toHaveBeenCalled();
  });
});
