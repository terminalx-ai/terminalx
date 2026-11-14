import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));

const { CommandPalette } = await import("./CommandPalette");
const store = await import("@/lib/sessions");

beforeEach(async () => {
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: "/alpha", name: "Alpha" }], lastSelected: "/alpha" };
    if (command === "list_sessions" || command === "list_workspaces" || command === "list_harnesses") return [];
    return null;
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  await act(async () => {
    await store.refreshEverything();
    store.selectSession(null);
  });
});

afterEach(async () => {
  cleanup();
  // Radix FocusScope dispatches its unmount event from a 0 ms timer. Let it run
  // while jsdom is still installed: after the file's environment is torn down
  // it throws an uncaught "parameter 1 is not of type 'Event'".
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function palette() {
  const props = { onOpenChange: vi.fn(), onOpenSettings: vi.fn(), onCreated: vi.fn() };
  const view = render(<CommandPalette open {...props} />);
  return { ...view, ...props, props, input: screen.getByLabelText("Command palette search") };
}

async function narrowToSettings(input: HTMLElement) {
  fireEvent.change(input, { target: { value: "Search settings" } });
  fireEvent.click(await screen.findByRole("option", { name: /Search settings…/ }));
  await waitFor(() => expect(input.getAttribute("placeholder")).toBe("Search settings…"));
}

describe("settings in the command palette", () => {
  it("opens repository settings for copy-pattern searches", async () => {
    const { input, onOpenSettings } = palette();
    await narrowToSettings(input);
    fireEvent.change(input, { target: { value: "worktreeinclude" } });
    await screen.findByRole("option", { name: /Repositories/ });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("repositories"));
  });

  it("lists matching sections in Settings and opens the font section with Enter", async () => {
    const { input, onOpenSettings, onOpenChange } = palette();
    fireEvent.change(input, { target: { value: "font" } });
    const group = await screen.findByRole("group", { name: "Settings" });
    const result = within(group).getByRole("option", { name: /Appearance/ });
    expect(result.querySelector("mark")?.textContent).toBe("font");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledWith("appearance"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("narrows to settings, supports arrow navigation, and leaves the scope with Backspace", async () => {
    const { input, onOpenChange } = palette();
    await narrowToSettings(input);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))).toEqual(["palette-group-settings"]);
    const results = screen.getAllByRole("option");
    expect(results).toHaveLength(15);
    expect(screen.getByRole("option", { name: /^Environment/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Projects/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Repositories/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results.at(-1)!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(results[0].id);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(await screen.findByRole("group", { name: "Views and commands" })).toBeTruthy();
  });

  it("keeps settings searches out of file and issue lookups and reports no matches", async () => {
    const { input } = palette();
    await narrowToSettings(input);
    mocks.invoke.mockClear();
    fireEvent.change(input, { target: { value: "font" } });
    await screen.findByRole("option", { name: /Appearance/ });
    // The ordinary file lookup is debounced for 45 ms.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(mocks.invoke).not.toHaveBeenCalledWith("search_files", expect.anything());
    fireEvent.change(input, { target: { value: "https://github.com/acme/app/issues/127" } });
    expect((await screen.findByRole("status")).textContent).toBe("No settings match https://github.com/acme/app/issues/127");
    expect(screen.queryByRole("group", { name: "Smart input" })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("issue_details", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Search everything" }));
    expect(input.getAttribute("placeholder")).not.toBe("Search settings…");
  });

  it("closes with Escape and resets the scope on the next opening", async () => {
    const { input, onOpenChange, props, rerender } = palette();
    await narrowToSettings(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<CommandPalette open={false} {...props} />);
    rerender(<CommandPalette open {...props} />);
    expect(await screen.findByRole("group", { name: "Views and commands" })).toBeTruthy();
    expect(screen.getByLabelText("Command palette search").getAttribute("placeholder")).not.toBe("Search settings…");
  });
});
