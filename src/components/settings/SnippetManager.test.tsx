import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { SnippetManager } = await import("./SnippetManager");
const { getPrefs, setPrefs } = await import("@/lib/prefs");

beforeEach(() => setPrefs({ promptSnippets: [] }));
afterEach(() => { cleanup(); setPrefs({ promptSnippets: [] }); });

describe("snippet manager", () => {
  it("lists each snippet by name with the first line of its text", () => {
    setPrefs({ promptSnippets: [{ id: "a", name: "review-pr", text: "Review the PR.\nList risks." }] });
    render(<SnippetManager />);
    expect(screen.getByText("/review-pr")).toBeTruthy();
    expect(screen.getByText("Review the PR.")).toBeTruthy();
  });

  it("creates a snippet from New snippet", () => {
    render(<SnippetManager />);
    fireEvent.click(screen.getByRole("button", { name: "New snippet" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "standup" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Summarize {{topic}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(getPrefs().promptSnippets).toMatchObject([{ name: "standup", text: "Summarize {{topic}}" }]);
    expect(screen.getByText("/standup")).toBeTruthy();
  });

  it("edits a snippet in place", () => {
    setPrefs({ promptSnippets: [{ id: "a", name: "review-pr", text: "Review the PR." }] });
    render(<SnippetManager />);
    fireEvent.click(screen.getByRole("button", { name: "Edit /review-pr" }));
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Review the PR and its tests." } });
    fireEvent.click(screen.getByRole("button", { name: "Save snippet" }));
    expect(getPrefs().promptSnippets).toEqual([{ id: "a", name: "review-pr", text: "Review the PR and its tests." }]);
  });

  it("deletes a snippet", () => {
    setPrefs({ promptSnippets: [{ id: "a", name: "one", text: "First" }, { id: "b", name: "two", text: "Second" }] });
    render(<SnippetManager />);
    fireEvent.click(screen.getByRole("button", { name: "Delete /one" }));
    expect(getPrefs().promptSnippets.map((snippet) => snippet.name)).toEqual(["two"]);
    expect(screen.queryByText("/one")).toBeNull();
  });
});
