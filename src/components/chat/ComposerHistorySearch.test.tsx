import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerHistorySearch, searchHistory } from "./ComposerHistorySearch";

afterEach(cleanup);

describe("composer history search", () => {
  it("finds every word in any order, newest first", () => {
    const history = ["fix the login bug", "add tests", "login BUG again"];
    expect(searchHistory(history, "bug login")).toEqual(["login BUG again", "fix the login bug"]);
    expect(searchHistory(history, "")).toEqual([...history].reverse());
    expect(searchHistory(history, "nothing")).toEqual([]);
  });

  it("picks with the arrows and Enter", () => {
    const onPick = vi.fn();
    render(<ComposerHistorySearch history={["first", "second"]} onPick={onPick} onClose={() => undefined} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("first");
  });

  it("picks the message that is clicked", () => {
    const onPick = vi.fn();
    render(<ComposerHistorySearch history={["first", "second"]} onPick={onPick} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "first" }));
    expect(onPick).toHaveBeenCalledWith("first");
  });

  it("says when the chat has no messages and when none match", () => {
    const view = render(<ComposerHistorySearch history={[]} onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole("status").textContent).toBe("No messages in this chat yet.");
    view.unmount();
    render(<ComposerHistorySearch history={["first"]} onPick={() => undefined} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz" } });
    expect(screen.getByRole("status").textContent).toBe("No message matches.");
  });

  it("shows at most the 50 newest matches", () => {
    const history = Array.from({ length: 80 }, (_, index) => `message ${index}`);
    const found = searchHistory(history, "message");
    expect(found).toHaveLength(50);
    expect(found[0]).toBe("message 79");
    expect(found[49]).toBe("message 30");
  });

  it("lists a message sent more than once a single time", () => {
    const history = ["deploy it", "run tests", "deploy it"];
    expect(searchHistory(history, "")).toEqual(["deploy it", "run tests"]);
    render(<ComposerHistorySearch history={history} onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});
