import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewFileList } from "./ReviewFileList";
import type { ChangedFile } from "@/types/session";
const files: ChangedFile[] = [
  { path: "src/deep/one.ts", status: "modified", additions: 2, deletions: 1, blobHash: "a" },
  { path: "src/two.ts", oldPath: "old-name.ts", status: "renamed", additions: 0, deletions: 0, blobHash: "b" },
  { path: "README.md", status: "added", additions: 1, deletions: 0, blobHash: "c" },
];
afterEach(cleanup);

it("filters folders and renamed paths, expands matches in collapsed folders, and retains selection", () => {
  const onSelect = vi.fn();
  render(<ReviewFileList workspace="filter" files={files} selected="src/deep/one.ts" onSelect={onSelect} empty="Empty" />);
  fireEvent.click(screen.getByRole("radio", { name: "Folders" }));
  fireEvent.click(screen.getByRole("button", { name: "Folder src" }));
  expect(screen.queryByRole("button", { name: /one.ts/ })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ONE.TS" } });
  expect(screen.getByRole("button", { name: /one.ts/ }).parentElement?.className).toContain("bg-selected");
  expect(screen.queryByRole("button", { name: /README/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /one.ts/ }));
  expect(onSelect).toHaveBeenCalledWith("src/deep/one.ts");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "old-name" } });
  expect(screen.getByRole("button", { name: /two.ts/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Folder src/deep" })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no match" } });
  expect(screen.getByText("No files match this filter.")).toBeTruthy();
});

it("marks without selecting a file, counts the entire scope, and unchecks on changed content", () => {
  const onSelect = vi.fn();
  const props = { workspace: "viewed-ui", files, selected: null, onSelect, empty: "Empty" };
  const view = render(<ReviewFileList {...props} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Viewed src/deep/one.ts" }));
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByText("1 of 3 viewed")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "README" } });
  expect(screen.getByText("1 of 3 viewed · 1 matching")).toBeTruthy();
  view.unmount();
  const reopened = render(<ReviewFileList {...props} />);
  expect(screen.getByRole("checkbox", { name: "Viewed src/deep/one.ts" })).toHaveProperty("checked", true);
  reopened.rerender(<ReviewFileList {...props} files={[{ ...files[0], blobHash: "changed" }, ...files.slice(1)]} />);
  expect(screen.getByRole("checkbox", { name: "Viewed src/deep/one.ts" })).toHaveProperty("checked", false);
  expect(screen.getByText("Changed since viewed")).toBeTruthy();
  expect(screen.getByText("0 of 3 viewed")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Viewed src/deep/one.ts" }));
  expect(screen.queryByText("Changed since viewed")).toBeNull();
});

it("cannot mark content from an older runtime with no blob identity", () => {
  render(<ReviewFileList workspace="old-runtime" files={[{ ...files[0], blobHash: undefined }]} selected={null} onSelect={() => {}} empty="Empty" />);
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
});
