import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { gh, type PullRequest } from "@/lib/api";
import { usePrMention } from "./usePrMention";
vi.mock("@/lib/api", () => ({ gh: { search: vi.fn(), attach: vi.fn() }, errorMessage: String }));
const pr = { number: 12, title: "Fix parser", author: "alice", state: "OPEN" } as PullRequest;
function Harness() {
  const [draft, setDraft] = useState("Review #12");
  const [caret, setCaret] = useState(draft.length);
  const field = useRef<HTMLTextAreaElement>(null);
  const mention = usePrMention("/repo", draft, caret, setDraft, field, setCaret);
  return <div>{mention.menu}<textarea aria-label="Prompt" ref={field} value={draft} onChange={(e) => { setDraft(e.target.value); setCaret(e.target.value.length); }} onKeyDown={mention.onKeyDown} /></div>;
}
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  vi.mocked(gh.search).mockResolvedValue([pr]);
  vi.mocked(gh.attach).mockResolvedValue("/context/pr-12.md");
});
afterEach(cleanup);

it.each(["Enter", "Tab"])("searches #12 and inserts the highlighted PR attachment with %s", async (key) => {
  render(<Harness />);
  await screen.findByRole("option", { name: /#12 Fix parser/ });
  expect(gh.search).toHaveBeenCalledWith("/repo", "12");
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key })).toBe(false);
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Review @/context/pr-12.md "));
  expect(gh.attach).toHaveBeenCalledWith("/repo", 12);
});

it("keeps the prompt on attachment failure and allows retry", async () => {
  vi.mocked(gh.attach).mockRejectedValueOnce(new Error("GitHub unavailable"));
  render(<Harness />);
  await screen.findByRole("option");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await screen.findByText("Error: GitHub unavailable");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Review #12");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("@/context/pr-12.md"));
});

it("does not replace a draft edited while the attachment was being fetched", async () => {
  let finish!: (path: string) => void;
  vi.mocked(gh.attach).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<Harness />);
  await screen.findByRole("option");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "A newer prompt" } });
  await act(async () => finish("/context/pr-12.md"));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A newer prompt");
});

it("discards stale search results and Escape dismisses an empty or loading picker", async () => {
  let old!: (prs: PullRequest[]) => void;
  vi.mocked(gh.search).mockImplementationOnce(() => new Promise((resolve) => { old = resolve; })).mockResolvedValue([]);
  render(<Harness />);
  await waitFor(() => expect(gh.search).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Review #99" } });
  await act(async () => old([pr]));
  expect(screen.queryByRole("option")).toBeNull();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("Escape cancels a pending insertion, and a new token can reopen the picker", async () => {
  let finish!: (path: string) => void;
  vi.mocked(gh.attach).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<Harness />);
  await screen.findByRole("option");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  await act(async () => finish("/context/pr-12.md"));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Review #12");
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Review " } });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Review #12" } });
  await screen.findByRole("option");
});
