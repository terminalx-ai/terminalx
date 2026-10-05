// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fs, type LocalPathInfo } from "@/lib/api";
import { openBrowserTab } from "@/lib/browser";
import { openFile } from "@/lib/editors";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { ChatLink } from "./ChatLink";

vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
vi.mock("@/lib/editors", () => ({ fileKind: () => "text", openFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));

const context = { sessionId: "session", cwd: "/workspace" };
const local = (path: string): LocalPathInfo => ({ path, root: "/tmp", rel: path.split("/").pop()!, kind: "file", text: true });

beforeEach(() => {
  vi.resetAllMocks();
  setPrefs({ linkBrowser: "ask", linkBrowserChosen: false, linkActions: true });
});
afterEach(cleanup);

describe("chat link actions", () => {
  it.each(["system", "terminalx"] as const)("opens directly in the saved %s browser", (linkBrowser) => {
    setPrefs({ linkBrowser });
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.click(screen.getByRole("link", { name: "website" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    if (linkBrowser === "system") {
      expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test");
      expect(openBrowserTab).not.toHaveBeenCalled();
    } else {
      expect(openBrowserTab).toHaveBeenCalledExactlyOnceWith("session", "/workspace", "https://example.test");
      expect(openUrl).not.toHaveBeenCalled();
    }
  });

  it.each(["system", "terminalx"] as const)("asks again after opening in %s without remembering", async (browser) => {
    // Link actions only controls the context menu; the chooser always offers both.
    setPrefs({ linkActions: false });
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    const link = screen.getByRole("link", { name: "website" });
    fireEvent.click(link);
    expect(await screen.findByRole("dialog", { name: "Open website link" })).toBeTruthy();
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();
    expect((screen.getByRole("checkbox", { name: "Remember my choice" }) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: browser === "system" ? "Open in system browser" : "Open in TerminalX browser" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    if (browser === "system") {
      expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test");
      expect(openBrowserTab).not.toHaveBeenCalled();
    } else {
      expect(openBrowserTab).toHaveBeenCalledExactlyOnceWith("session", "/workspace", "https://example.test");
      expect(openUrl).not.toHaveBeenCalled();
    }
    expect(getPrefs().linkBrowser).toBe("ask");
    fireEvent.click(link);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(vi.mocked(openUrl).mock.calls.length + vi.mocked(openBrowserTab).mock.calls.length).toBe(1);
  });

  it.each(["system", "terminalx"] as const)("remembers %s for already-rendered links and lets Settings re-enable the chooser", async (browser) => {
    render(<>
      <ChatLink href="https://example.test/first" context={context}>first</ChatLink>
      <ChatLink href="https://example.test/second" context={context}>second</ChatLink>
    </>);
    fireEvent.click(screen.getByRole("link", { name: "first" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remember my choice" }));
    // Ticking alone must neither remember a browser nor open anything.
    expect(getPrefs().linkBrowser).toBe("ask");
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: browser === "system" ? "Open in system browser" : "Open in TerminalX browser" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(getPrefs()).toMatchObject({ linkBrowser: browser, linkBrowserChosen: true });
    expect(JSON.parse(localStorage.getItem("raccoon.prefs")!)).toMatchObject({ linkBrowser: browser, linkBrowserChosen: true });

    fireEvent.click(screen.getByRole("link", { name: "second" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(browser === "system" ? openUrl : openBrowserTab).toHaveBeenCalledTimes(2);
    expect(browser === "system" ? openBrowserTab : openUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "second" }).title).toContain(browser === "system" ? "TerminalX Browser" : "System Browser");

    act(() => setPrefs({ linkBrowser: "ask" }));
    fireEvent.click(screen.getByRole("link", { name: "second" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("focuses the chooser on keyboard activation and restores the link on Escape without saving", async () => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    const link = screen.getByRole("link", { name: "website" });
    link.focus();
    // Enter on an anchor generates a native click with detail=0.
    fireEvent.click(link, { detail: 0 });
    const system = await screen.findByRole("button", { name: "Open in system browser" });
    await waitFor(() => expect(document.activeElement).toBe(system));
    expect(link.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember my choice" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
    expect(getPrefs().linkBrowser).toBe("ask");
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();

    fireEvent.click(link);
    expect((await screen.findByRole("checkbox", { name: "Remember my choice" }) as HTMLInputElement).checked).toBe(false);
  });

  it("dismisses the chooser on an outside press", async () => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.click(screen.getByRole("link", { name: "website" }));
    await screen.findByRole("dialog");
    // Radix installs the outside-pointer listener on the next task.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();
  });

  it.each(["ask", "system", "terminalx"] as const)("preserves modifier-click and the context menu in %s mode", async (linkBrowser) => {
    setPrefs({ linkBrowser });
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    const link = screen.getByRole("link", { name: "website" });
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      fireEvent.click(link, { shiftKey: true, ...modifier });
    }
    expect(linkBrowser === "terminalx" ? openUrl : openBrowserTab).toHaveBeenCalledTimes(2);
    expect(linkBrowser === "terminalx" ? openBrowserTab : openUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.contextMenu(link);
    expect(await screen.findByRole("menuitem", { name: "Open in TerminalX Browser" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in System Browser" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(openUrl).toHaveBeenCalledWith("https://example.test");
    expect(getPrefs().linkBrowser).toBe(linkBrowser);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the chooser for middle-clicks in ask mode", async () => {
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    fireEvent(screen.getByRole("link", { name: "website" }), event);
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();
  });

  it("closes a chooser when the rendered destination changes", async () => {
    const { rerender } = render(<ChatLink href="https://example.test/old" context={context}>website</ChatLink>);
    fireEvent.click(screen.getByRole("link", { name: "website" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Remember my choice" }));
    rerender(<ChatLink href="https://example.test/new" context={context}>website</ChatLink>);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("link", { name: "website" }));
    expect((await screen.findByRole("checkbox", { name: "Remember my choice" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.test/new");
    expect(getPrefs().linkBrowser).toBe("ask");
  });

  it.each(["mailto:hello@example.test", "tel:+123456789"])("leaves %s with the system handler in ask mode", (href) => {
    render(<ChatLink href={href} context={context}>contact</ChatLink>);
    fireEvent.click(screen.getByRole("link", { name: "contact" }));
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(href);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openBrowserTab).not.toHaveBeenCalled();
  });

  it("leaves file and anchor links unaffected in ask mode", async () => {
    vi.mocked(fs.inspectPath).mockResolvedValue(local("/tmp/file.txt"));
    render(<>
      <ChatLink href="/tmp/file.txt" context={context}>file</ChatLink>
      <ChatLink href="#missing-anchor" context={context}>anchor</ChatLink>
    </>);
    fireEvent.click(screen.getByRole("link", { name: "file" }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith("session", "/tmp", "file.txt", undefined, "/workspace"));
    fireEvent.click(screen.getByRole("link", { name: "anchor" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
    expect(openBrowserTab).not.toHaveBeenCalled();
  });

  it("reports a browser failure from the chooser", async () => {
    vi.mocked(openUrl).mockRejectedValue(new Error("No registered browser"));
    render(<ChatLink href="https://example.test" context={context}>website</ChatLink>);
    fireEvent.click(screen.getByRole("link", { name: "website" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open in system browser" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No registered browser");
    expect(openBrowserTab).not.toHaveBeenCalled();
  });

  describe("saved browser choices", () => {
    beforeEach(() => setPrefs({ linkBrowser: "system", linkBrowserChosen: true }));

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
