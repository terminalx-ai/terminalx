import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IconPicker, RepositoryIcon } from "./IconPicker";

afterEach(cleanup);

it("searches icon names and keywords, and reports the selected icon", () => {
  const onChange = vi.fn();
  const { rerender } = render(<IconPicker value="folder" onChange={onChange} label="Repository icon" />);
  expect(screen.getByRole("group", { name: "Repository icon choices" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Folder" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search icons" }), { target: { value: " DEPLOY " } });
  expect(screen.queryByRole("button", { name: "Folder" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Rocket" }));
  expect(onChange).toHaveBeenCalledWith("rocket");
  rerender(<IconPicker value="rocket" onChange={onChange} label="Repository icon" />);
  expect(screen.getByRole("button", { name: "Rocket" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no such icon" } });
  expect(screen.getByRole("status").textContent).toBe("No matching icons.");
});

it("disables controls during a save and safely renders an unknown id", () => {
  const { container } = render(<><IconPicker value="future-icon" onChange={vi.fn()} disabled /><RepositoryIcon value="__proto__" /></>);
  expect(screen.getByRole("searchbox").matches(":disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Folder" }).matches(":disabled")).toBe(true);
  expect(container.querySelector("svg")).toBeTruthy();
});

it("does not let Enter in the search field implicitly submit its enclosing form", () => {
  render(<form><IconPicker value="play" onChange={vi.fn()} /></form>);
  expect(fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" })).toBe(false);
  // Leave Command-Enter to the action editor's save handler.
  expect(fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter", metaKey: true })).toBe(true);
});
