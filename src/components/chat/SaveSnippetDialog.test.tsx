import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { SaveSnippetDialog, snippetName } from "./SaveSnippetDialog";

const snippets = () => getPrefs().promptSnippets;

beforeEach(() => setPrefs({ promptSnippets: [] }));
afterEach(() => { cleanup(); setPrefs({ promptSnippets: [] }); });

describe("save snippet dialog", () => {
  it("turns a name into the form typed after /", () => {
    expect(snippetName("  Review the PR!  ")).toBe("review-the-pr");
  });

  it("saves a new snippet under a name taken from the prompt", () => {
    const onClose = vi.fn();
    render(<SaveSnippetDialog prompt="Review the open PR carefully now" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(snippets()).toMatchObject([{ name: "review-the-open-pr", text: "Review the open PR carefully now" }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("renames a snippet being edited, keeping its id and leaving the others", () => {
    setPrefs({ promptSnippets: [{ id: "a", name: "old-name", text: "Old text" }, { id: "b", name: "other", text: "Other" }] });
    render(<SaveSnippetDialog prompt="Old text" editing={snippets()[0]} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(snippets()).toEqual([{ id: "b", name: "other", text: "Other" }, { id: "a", name: "new-name", text: "Old text" }]);
  });

  it("replaces another snippet when an edit takes its name", () => {
    setPrefs({ promptSnippets: [{ id: "a", name: "one", text: "First" }, { id: "b", name: "two", text: "Second" }] });
    render(<SaveSnippetDialog prompt="First" editing={snippets()[0]} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "two" } });
    expect(screen.getByText("Replaces the snippet /two.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace snippet" }));
    expect(snippets()).toEqual([{ id: "a", name: "two", text: "First" }]);
  });

  it("does not save without a name", () => {
    render(<SaveSnippetDialog prompt="Some text" onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "" } });
    expect((screen.getByRole("button", { name: "Save snippet" }) as HTMLButtonElement).disabled).toBe(true);
    expect(snippets()).toEqual([]);
  });
});
