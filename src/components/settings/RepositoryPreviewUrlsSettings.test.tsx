import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { RepositoryPreviewUrlsSettings } from "./RepositoryPreviewUrlsSettings";

afterEach(cleanup);
const web = { id: "web", name: "Web", url: "http://localhost:$PORT" };
const docs = { id: "docs", name: "Docs", url: "https://example.com/docs" };
const field = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;
const edit = (label: string, value: string) => fireEvent.change(field(label), { target: { value } });

function Editor({ save = async () => {} }: { save?: (urls: RepositoryPreviewUrl[]) => Promise<void> }) {
  const [urls, setUrls] = useState([web, docs]);
  return <><RepositoryPreviewUrlsSettings urls={urls} onChange={async (next) => { await save(next); setUrls(next); }} /><button type="button">Elsewhere</button></>;
}

it("shows each URL as inline name and URL fields, with ↑ ↓ × and Add preview URL beneath (design 11.02)", () => {
  render(<Editor />);
  expect(field("Name of Web").value).toBe("Web");
  expect(field("URL of Web").value).toBe("http://localhost:$PORT");
  expect(screen.getByRole("button", { name: "Move Web up" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Delete Docs" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add preview URL" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("adds a row and saves it once it is valid and focus leaves it, trimmed", async () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add preview URL" }));
  edit("Name of new preview URL", "  API  ");
  edit("URL of API", " http://localhost:$PORT_2/api ");
  fireEvent.blur(field("URL of API"), { relatedTarget: screen.getByRole("button", { name: "Elsewhere" }) });
  await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith([web, docs, { id: expect.any(String), name: "API", url: "http://localhost:$PORT_2/api" }]));
  expect(field("Name of API").value).toBe("API");
});

it("drops a new row left blank, and does not save while focus moves within a row", async () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add preview URL" }));
  fireEvent.blur(field("Name of new preview URL"), { relatedTarget: field("URL of new preview URL") });
  expect(screen.getByRole("textbox", { name: "Name of new preview URL" })).toBeTruthy();
  fireEvent.blur(field("URL of new preview URL"), { relatedTarget: null });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name of new preview URL" })).toBeNull());
  expect(save).not.toHaveBeenCalled();
});

it("validates names, duplicates, URLs and placeholders inline, saving nothing until fixed", async () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  edit("Name of Web", " docs ");
  fireEvent.keyDown(field("Name of Web"), { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toBe("Choose a unique name.");
  edit("Name of Web", "Web");
  edit("URL of Web", "http://localhost:$PORT_0");
  expect(screen.getByRole("alert").textContent).toBe("Use $PORT or $PORT_n, with n starting at 1.");
  expect(field("URL of Web").getAttribute("aria-invalid")).toBe("true");
  expect(save).not.toHaveBeenCalled();
  edit("URL of Web", "http://localhost:$PORT/app");
  fireEvent.keyDown(field("URL of Web"), { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenCalledWith([{ ...web, url: "http://localhost:$PORT/app" }, docs]));
});

it("Escape puts back the saved text; an unchanged row saves nothing", () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  edit("Name of Web", "Unsaved");
  fireEvent.keyDown(field("Name of Web"), { key: "Escape" });
  expect(field("Name of Web").value).toBe("Web");
  fireEvent.blur(field("Name of Web"), { relatedTarget: null });
  expect(save).not.toHaveBeenCalled();
});

it("keeps the draft after a failed save for retry", async () => {
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce(new Error("Disk is full."));
  render(<Editor save={save} />);
  edit("URL of Web", "http://localhost:$PORT/app");
  fireEvent.keyDown(field("URL of Web"), { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk is full.");
  expect(field("URL of Web").value).toBe("http://localhost:$PORT/app");
  fireEvent.keyDown(field("URL of Web"), { key: "Enter" });
  await waitFor(() => expect(save).toHaveBeenLastCalledWith([{ ...web, url: "http://localhost:$PORT/app" }, docs]));
});

it("reorders and deletes URLs without changing the other entries", async () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Move Web down" }));
  await waitFor(() => expect((within(screen.getByRole("list", { name: "Saved preview URLs" })).getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("Docs"));
  expect(save).toHaveBeenCalledWith([docs, web]);
  fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Name of Docs" })).toBeNull());
  expect(save).toHaveBeenLastCalledWith([web]);
});

it("shows a fallback when a rejected write has no error message", async () => {
  render(<Editor save={async () => { throw new Error(""); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete Web" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not save changes. Try again.");
  expect(field("Name of Web")).toBeTruthy();
});
