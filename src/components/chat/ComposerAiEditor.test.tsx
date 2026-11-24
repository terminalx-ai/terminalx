import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiEditorBackend } from "@/lib/aiEdit";
import { ComposerAiEditor } from "./ComposerAiEditor";

function setup(answer: () => Promise<string>, draft = "fix teh prompt") {
  const backend: AiEditorBackend = { run: vi.fn(answer), cancel: vi.fn() };
  const onApply = vi.fn();
  const onApplyAndSend = vi.fn();
  const onOpenChange = vi.fn();
  const element = (text: string, open = true) => (
    <ComposerAiEditor draft={text} backend={backend} disabled={false} reason={null} open={open} onOpenChange={onOpenChange} onApply={onApply} onApplyAndSend={onApplyAndSend} canSend />
  );
  const view = render(element(draft));
  return { backend, onApply, onApplyAndSend, view, element };
}

afterEach(cleanup);

describe("ComposerAiEditor", () => {
  it("shows a word diff, and applies only when asked", async () => {
    const { backend, onApply } = setup(async () => "Fix the prompt");
    fireEvent.click(screen.getByTestId("ai-editor-run"));
    expect(backend.run).toHaveBeenCalledWith({ kind: "fix" }, "fix teh prompt", expect.any(String));
    const diff = await screen.findByTestId("ai-editor-diff");
    expect([...diff.querySelectorAll("del")].map((part) => part.textContent)).toEqual(["fix", "teh"]);
    expect([...diff.querySelectorAll("ins")].map((part) => part.textContent)).toEqual(["Fix", "the"]);
    expect(screen.getByText("2 suggestions")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("ai-editor-apply"));
    expect(onApply).toHaveBeenCalledWith("Fix the prompt");
  });

  it("hands the result to Apply & send", async () => {
    const { onApplyAndSend } = setup(async () => "Fix the prompt");
    fireEvent.click(screen.getByTestId("ai-editor-run"));
    fireEvent.click(await screen.findByTestId("ai-editor-apply-send"));
    expect(onApplyAndSend).toHaveBeenCalledWith("Fix the prompt");
  });

  it("never applies over a draft edited since it asked", async () => {
    const { view, element } = setup(async () => "Fix the prompt");
    fireEvent.click(screen.getByTestId("ai-editor-run"));
    await screen.findByTestId("ai-editor-apply");
    view.rerender(element("fix teh prompt, and more"));
    expect(screen.queryByTestId("ai-editor-apply")).toBeNull();
    expect(screen.getByText(/The draft changed/)).toBeTruthy();
  });

  it("says when there is nothing to change", async () => {
    setup(async () => "fix teh prompt");
    fireEvent.click(screen.getByTestId("ai-editor-run"));
    expect(await screen.findByText("Looks good. Nothing to change.")).toBeTruthy();
    expect(screen.queryByTestId("ai-editor-apply")).toBeNull();
  });

  it("shows a failure and can run again", async () => {
    setup(() => Promise.reject("Claude Code is signed out. Sign in, then try again."));
    fireEvent.click(screen.getByTestId("ai-editor-run"));
    expect(await screen.findByText(/signed out/)).toBeTruthy();
    expect(screen.getByTestId("ai-editor-run")).toBeTruthy();
  });

  it("cancels the run when it is closed, and ignores a late answer", async () => {
    let answer: (text: string) => void = () => undefined;
    const { backend, view, element, onApply } = setup(() => new Promise((resolve) => { answer = resolve; }));
    fireEvent.click(screen.getByTestId("ai-editor-run"));
    view.rerender(element("fix teh prompt", false));
    await waitFor(() => expect(backend.cancel).toHaveBeenCalledTimes(1));
    answer("Late");
    await Promise.resolve();
    expect(screen.queryByText("Late")).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });
});
