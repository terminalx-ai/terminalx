import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnippetVariablesDialog } from "./SnippetVariablesDialog";

afterEach(cleanup);

describe("snippet variables dialog", () => {
  it("asks once for each placeholder and inserts the filled text", () => {
    const onInsert = vi.fn();
    render(<SnippetVariablesDialog text="Review {{pr}} for {{team}}, then {{pr}} again." onInsert={onInsert} onClose={() => undefined} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("pr"), { target: { value: "#42" } });
    fireEvent.change(screen.getByLabelText("team"), { target: { value: "web" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith("Review #42 for web, then #42 again.");
  });

  it("leaves an empty placeholder as written", () => {
    const onInsert = vi.fn();
    render(<SnippetVariablesDialog text="Fix {{bug}} in {{file}}" onInsert={onInsert} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("file"), { target: { value: "a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(onInsert).toHaveBeenCalledWith("Fix {{bug}} in a.ts");
  });

  it("inserts on Enter in a field", () => {
    const onInsert = vi.fn();
    render(<SnippetVariablesDialog text="Hello {{name}}" onInsert={onInsert} onClose={() => undefined} />);
    const field = screen.getByLabelText("name");
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.submit(field.closest("form")!);
    expect(onInsert).toHaveBeenCalledWith("Hello Ada");
  });

  it("closes on Cancel without inserting", () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(<SnippetVariablesDialog text="Hello {{name}}" onInsert={onInsert} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
  });
});
