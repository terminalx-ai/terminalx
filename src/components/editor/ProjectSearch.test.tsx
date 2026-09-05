import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextHit, TextSearch } from "@/lib/api";

const { invoke, ask } = vi.hoisted(() => ({ invoke: vi.fn(), ask: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));

const { ProjectSearch } = await import("./ProjectSearch");

const hit = (path: string, line: number, text: string, matches: [number, number][]): TextHit => ({ path, line, col: matches[0][0], text, matches });

/** What the backend would answer, with the replacement rendered when one is sent. */
function answer(replacement: string | null): TextSearch {
  const withPreview = (h: TextHit): TextHit => (replacement == null ? h : { ...h, replacements: h.matches.map(() => replacement) });
  return {
    hits: [hit("src/a.ts", 1, "foo();", [[0, 3]]), hit("src/a.ts", 2, "let foo = foo;", [[4, 7], [10, 13]]), hit("b.md", 3, "# foo", [[2, 5]])].map(withPreview),
    files: 2,
    capped: false,
  };
}

function openWith(chord: "f" | "h") {
  fireEvent.keyDown(window, { key: chord, code: `Key${chord.toUpperCase()}`, ctrlKey: true, shiftKey: true });
}

beforeEach(() => {
  invoke.mockReset();
  ask.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "search_text") return answer((args.replacement as string | null) ?? null);
    if (command === "replace_text") return { files: 2, replacements: 4 };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(cleanup);

describe("ProjectSearch", () => {
  it("searches on ⌘⇧F without a replace row", async () => {
    render(<ProjectSearch sessionId="s1" root="/repo" />);
    openWith("f");
    const search = await screen.findByPlaceholderText("Search in project");
    fireEvent.change(search, { target: { value: "foo" } });
    await screen.findByText("src/a.ts");
    expect(screen.queryByLabelText("Replace with")).toBeNull();
    expect(screen.getByText(/4 matches in 2 files/)).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("search_text", expect.objectContaining({ root: "/repo", query: "foo", replacement: null }));
  });

  it("previews the replacement, honours exclusions, confirms, and reports", async () => {
    ask.mockResolvedValue(true);
    render(<ProjectSearch sessionId="s1" root="/repo" />);
    openWith("h");
    const replace = await screen.findByLabelText("Replace with");
    fireEvent.change(screen.getByPlaceholderText("Search in project"), { target: { value: "foo" } });
    fireEvent.change(replace, { target: { value: "bar" } });
    await screen.findByText("src/a.ts");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("search_text", expect.objectContaining({ query: "foo", replacement: "bar" })));

    // Each of the four matches is shown struck out beside what it becomes.
    await waitFor(() => expect(screen.getAllByText("foo", { selector: "del" })).toHaveLength(4));
    expect(screen.getAllByText("bar", { selector: "ins" })).toHaveLength(4);

    // Leave the second line of a.ts out: that file is now rewritten by line, b.md whole.
    fireEvent.click(screen.getByRole("checkbox", { name: "Include line 2" }));
    const go = screen.getByRole("button", { name: /^Replace 2$/ });
    fireEvent.click(go);
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask.mock.calls[0][0]).toMatch(/Replace 2 matches in 2 files with “bar”\?/);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_text", {
        root: "/repo",
        query: "foo",
        replacement: "bar",
        regex: false,
        caseSensitive: false,
        targets: [{ path: "src/a.ts", lines: [1] }, { path: "b.md" }],
        skip: [],
      }),
    );
    await screen.findByText("Replaced 4 matches in 2 files.");
  });

  it("does nothing when the confirmation is declined", async () => {
    ask.mockResolvedValue(false);
    render(<ProjectSearch sessionId="s1" root="/repo" />);
    openWith("h");
    fireEvent.change(await screen.findByPlaceholderText("Search in project"), { target: { value: "foo" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "bar" } });
    await screen.findByText("src/a.ts");
    fireEvent.click(await screen.findByRole("button", { name: /^Replace 4$/ }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(invoke.mock.calls.some(([c]) => c === "replace_text")).toBe(false);
  });

  it("unticks every line of a file from its header and replaces a single line without asking", async () => {
    render(<ProjectSearch sessionId="s1" root="/repo" />);
    openWith("h");
    fireEvent.change(await screen.findByPlaceholderText("Search in project"), { target: { value: "foo" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "bar" } });
    await screen.findByText("src/a.ts");
    fireEvent.click(screen.getByRole("checkbox", { name: "Include src/a.ts" }));
    expect(screen.getByRole("checkbox", { name: "Include line 1" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: /^Replace 1$/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace on line 3" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("replace_text", expect.objectContaining({ targets: [{ path: "b.md" }] })),
    );
    expect(ask).not.toHaveBeenCalled();
  });
});
