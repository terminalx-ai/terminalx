import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitSource } from "@/lib/gitSource";
import type { CommitInfo } from "@/types/session";
import { CommitPicker } from "./CommitPicker";
afterEach(cleanup);
const commits: CommitInfo[] = Array.from({ length: 61 }, (_, i) => ({ sha: i.toString(16).padStart(40, "a"), shortSha: `commit${i}`, subject: `Change ${i}`, parent: null, tree: "tree", author: "A", email: "a@example.com", date: "", body: "" }));

it("loads older commits while keeping the selected commit", async () => {
  const source = { logCommits: vi.fn(async (_from, limit) => commits.slice(0, limit)), errorMessage: String } as unknown as GitSource;
  const onChange = vi.fn();
  render(<CommitPicker source={source} active value={commits[0].sha} onChange={onChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Load older commits" }));
  await screen.findByRole("option", { name: "commit60 · Change 60" });
  expect(screen.getByLabelText("Commit to review")).toHaveProperty("value", commits[0].sha);
  fireEvent.change(screen.getByLabelText("Commit to review"), { target: { value: commits[60].sha } });
  expect(onChange).toHaveBeenLastCalledWith(commits[60].sha);
});

it("retries failed history and accepts a commit outside the history list without accepting git options", async () => {
  const logCommits = vi.fn().mockRejectedValueOnce("offline").mockResolvedValue([]);
  const source = { logCommits, errorMessage: String } as unknown as GitSource;
  const onChange = vi.fn();
  render(<CommitPicker source={source} active value={null} onChange={onChange} />);
  await screen.findByText(/offline/);
  fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
  await screen.findByText("No commits yet.");
  fireEvent.click(screen.getByText("Find by commit ID"));
  fireEvent.change(screen.getByLabelText("Commit ID"), { target: { value: "--all" } });
  fireEvent.click(screen.getByRole("button", { name: "Review commit" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Commit ID"), { target: { value: "  ABCDEF123  " } });
  fireEvent.click(screen.getByRole("button", { name: "Review commit" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("abcdef123"));
});
