import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InNoticeColumn, NoticeColumn } from "./NoticeColumn";

afterEach(cleanup);

// #1499: notices sit top right, never in the bottom corner where the composer is.
it("puts the window's notices top right, under the tabs", () => {
  render(<NoticeColumn><div>Claude Code finished</div></NoticeColumn>);
  const column = screen.getByText("Claude Code finished").parentElement!;
  expect(column.className).toContain("top-22");
  expect(column.className).toContain("right-4");
  expect(column.className).not.toMatch(/\bbottom-/);
});

it("takes a notice raised deep in a page into the window's column, after the toasts", () => {
  render(<>
    <NoticeColumn><div>Claude Code finished</div></NoticeColumn>
    <main><InNoticeColumn><div role="alert">Can't save settings</div></InNoticeColumn></main>
  </>);
  const column = screen.getByText("Claude Code finished").parentElement!;
  expect(screen.getByRole("alert").parentElement).toBe(column);
  expect(column.lastElementChild).toBe(screen.getByRole("alert"));
});

it("takes the same place on its own when the page has no column", () => {
  render(<InNoticeColumn><div role="alert">Can't save settings</div></InNoticeColumn>);
  const own = screen.getByRole("alert").parentElement!;
  expect(own.className).toContain("top-22");
  expect(own.className).toContain("right-4");
});
