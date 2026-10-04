// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fs, type LocalPathInfo } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { ChatLink } from "./ChatLink";

vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
vi.mock("@/lib/editors", () => ({ fileKind: () => "text", openFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));

const context = { sessionId: "session", cwd: "/workspace" };
const local = (path: string): LocalPathInfo => ({ path, root: "/tmp", rel: path.split("/").pop()!, kind: "file", text: true });

const initialPrefs = getPrefs();
beforeEach(() => {
  vi.resetAllMocks();
  setPrefs(initialPrefs);
});
afterEach(cleanup);

describe("chat link actions", () => {
  it("opens a plain click only in the system browser and describes the primary action", async () => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    const link = screen.getByRole("link", { name: "website" });
    expect(link.title).toMatch(/^Open in System Browser; .+-click to open in TerminalX Browser$/);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test"));
    expect(openBrowserTab).not.toHaveBeenCalled();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("opens the TerminalX alternate on Shift-modifier click (%j)", async (modifier) => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.click(screen.getByRole("link", { name: "website" }), { shiftKey: true, ...modifier });
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledExactlyOnceWith("session", "/workspace", "https://example.test"));
    expect(openUrl).not.toHaveBeenCalled();
    expect(getPrefs().linkBrowser).toBe("system");
  });

  it("lists System Browser first and opens TerminalX on context-menu request", async () => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.contextMenu(screen.getByRole("link", { name: "website" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Open in System Browser", "Open in TerminalX Browser", "Copy link",
    ]);
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in TerminalX Browser" }));
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledExactlyOnceWith("session", "/workspace", "https://example.test"));
    expect(openUrl).not.toHaveBeenCalled();
    expect(getPrefs().linkBrowser).toBe("system");
  });

  it("updates the title, menu, and routes when the reader chooses TerminalX in Settings", async () => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    act(() => setPrefs({ linkBrowser: "terminalx", linkBrowserChosen: true }));
    const link = screen.getByRole("link", { name: "website" });
    expect(link.title).toMatch(/^Open in TerminalX Browser; .+-click to open in System Browser$/);

    fireEvent.click(link);
    await waitFor(() => expect(openBrowserTab).toHaveBeenCalledExactlyOnceWith("session", "/workspace", "https://example.test"));
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(link, { shiftKey: true, metaKey: true });
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test"));
    expect(openBrowserTab).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(link);
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Open in TerminalX Browser", "Open in System Browser", "Copy link",
    ]);
  });

  it("keeps the primary action when alternate menu actions are hidden", async () => {
    setPrefs({ linkActions: false });
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.contextMenu(screen.getByRole("link", { name: "website" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Open in System Browser", "Copy link",
    ]);
  });

  it("does not apply a stale context-menu inspection after the href changes", async () => {
    let resolveOld!: (value: LocalPathInfo) => void;
    vi.mocked(fs.inspectPath)
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(local("/tmp/new.txt"));
    const { rerender } = render(<ChatLink href="/tmp/old.txt" context={context}>file</ChatLink>);
    fireEvent.contextMenu(screen.getByRole("link", { name: "file" }));
    expect(await screen.findByRole("menuitem", { name: "Checking destination…" })).toBeTruthy();

    rerender(<ChatLink href="/tmp/new.txt" context={context}>file</ChatLink>);
    resolveOld(local("/tmp/old.txt"));
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Open internally" })).toBeNull());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(screen.getByRole("link", { name: "file" }));
    const external = await screen.findByRole("menuitem", { name: "Open with default application" });
    fireEvent.click(external);
    await waitFor(() => expect(fs.openPath).toHaveBeenCalledWith("/tmp/new.txt"));
    expect(fs.openPath).not.toHaveBeenCalledWith("/tmp/old.txt");
  });

  it("offers internal/default/copy actions for web destinations and reports handler failures", async () => {
    vi.mocked(openUrl).mockRejectedValue(new Error("No registered browser"));
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.contextMenu(screen.getByRole("link", { name: "website" }));
    expect(await screen.findByRole("menuitem", { name: "Open in TerminalX Browser" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in System Browser" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No registered browser");
  });
});
