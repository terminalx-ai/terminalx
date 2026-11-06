import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RepositoryPreviewUrl } from "@/lib/repositoryActions";
import { RepositoryPreviewUrlsSettings } from "./RepositoryPreviewUrlsSettings";

afterEach(cleanup);
const web = { id: "web", name: "Web", url: "http://localhost:$PORT" };
const docs = { id: "docs", name: "Docs", url: "https://example.com/docs" };
const edit = (label: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });

function Editor({ save = async () => {} }: { save?: (urls: RepositoryPreviewUrl[]) => Promise<void> }) {
  const [urls, setUrls] = useState([web, docs]);
  return <RepositoryPreviewUrlsSettings urls={urls} onChange={async (next) => { await save(next); setUrls(next); }} />;
}

it("adds a named template without allocating ports or opening a browser", async () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
  expect((screen.getByRole("textbox", { name: "URL" }) as HTMLInputElement).value).toBe("http://localhost:$PORT");
  edit("Name", "  API  ");
  edit("URL", " http://localhost:$PORT_2/api ");
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledExactlyOnceWith([web, docs, { id: expect.any(String), name: "API", url: "http://localhost:$PORT_2/api" }]);
  expect(screen.getByRole("button", { name: "Edit API" })).toBeTruthy();
});

it("validates required names, duplicates, URLs and unsupported placeholders inline", () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
  edit("URL", "");
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual(["Enter a name.", "Enter a URL."]);
  edit("Name", " web ");
  edit("URL", "javascript:alert(1)");
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  expect(screen.getByText("Choose a unique name.")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "URL" }).getAttribute("aria-invalid")).toBe("true");
  edit("Name", "API");
  edit("URL", "http://localhost:$PORT_0");
  expect(screen.getByRole("alert").textContent).toBe("Use $PORT or $PORT_n, with n starting at 1.");
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  expect(save).not.toHaveBeenCalled();
});

it("edits in place and retains the draft after a save failure for retry", async () => {
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce(new Error("Disk is full."));
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Web" }));
  edit("URL", "http://localhost:$PORT/app");
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk is full.");
  expect((screen.getByRole("textbox", { name: "URL" }) as HTMLInputElement).value).toBe("http://localhost:$PORT/app");
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenLastCalledWith([{ ...web, url: "http://localhost:$PORT/app" }, docs]);
});

it("reorders and deletes URLs without changing the other entries", async () => {
  const save = vi.fn(async () => {});
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Move Web down" }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "Saved preview URLs" })).getAllByRole("listitem")[0].textContent).toContain("Docs"));
  expect(save).toHaveBeenCalledWith([docs, web]);
  expect(screen.getByRole("button", { name: "Move Web down" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete Docs" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Edit Docs" })).toBeNull());
  expect(save).toHaveBeenLastCalledWith([web]);
});

it("keeps the saved list on a failed reorder and discards a cancelled draft", async () => {
  const save = vi.fn(async () => {});
  save.mockRejectedValueOnce("Could not save.");
  render(<Editor save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Move Web down" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not save.");
  expect(within(screen.getByRole("list", { name: "Saved preview URLs" })).getAllByRole("listitem")[0].textContent).toContain("Web");
  fireEvent.click(screen.getByRole("button", { name: "Edit Web" }));
  edit("Name", "Unsaved");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Web" }));
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Web");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
});

it("refuses to silently save a concurrently deleted URL", async () => {
  const save = vi.fn(async () => {});
  const { rerender } = render(<RepositoryPreviewUrlsSettings urls={[web]} onChange={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Web" }));
  rerender(<RepositoryPreviewUrlsSettings urls={[]} onChange={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Save URL" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This URL was removed. Close the dialog and add it again.");
  expect(save).not.toHaveBeenCalled();
});

it("shows a fallback when a rejected write has no error message", async () => {
  render(<Editor save={async () => { throw new Error(""); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete Web" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not save changes. Try again.");
  expect(screen.getByRole("button", { name: "Edit Web" })).toBeTruthy();
});
