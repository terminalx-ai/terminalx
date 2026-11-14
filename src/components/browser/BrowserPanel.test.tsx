import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "@/lib/api";

const state = { loaded: true, pages: [] as BrowserPage[], screencast: {} };
const openBrowserPage = vi.fn(async () => "p2");
const focusBrowserPage = vi.fn(async () => undefined);
vi.mock("@/lib/browser", () => ({
  useBrowser: () => state,
  bootBrowser: vi.fn(async () => undefined),
  pagesFor: (pages: BrowserPage[], cwd: string) => pages.filter((p) => p.workspacePath === cwd),
  openBrowserPage: (...args: unknown[]) => openBrowserPage(...(args as [])),
  closeBrowserPage: vi.fn(async () => undefined),
  focusBrowserPage: (...args: unknown[]) => focusBrowserPage(...(args as [])),
}));
vi.mock("./BrowserView", () => ({ BrowserView: ({ page }: { page: BrowserPage }) => <div data-testid="browser-view">{page.url}</div> }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { BrowserPanel } from "./BrowserPanel";

afterEach(cleanup);
const page = (id: string, url: string, workspacePath = "/repo"): BrowserPage => ({ id, browserPageId: id, profileId: "default", tabId: id, url, title: "", workspacePath, created: "", active: false, index: 0 });
const draw = () => render(<TooltipProvider><BrowserPanel sessionId="s" cwd="/repo" active /></TooltipProvider>);

describe("the side panel's browser", () => {
  it("offers an address when the workspace has no page, and opens it in this workspace", async () => {
    state.pages = [page("other", "http://elsewhere", "/other")];
    draw();
    expect(screen.queryByTestId("browser-view")).toBeNull();
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "localhost:5173" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(openBrowserPage).toHaveBeenCalledWith("/repo", "localhost:5173"));
  });

  it("shows the workspace's pages as tabs over the page, and the one picked", () => {
    state.pages = [page("p1", "http://localhost:3000/"), page("p2", "https://example.com/docs")];
    draw();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["localhost:3000", "example.com"]);
    fireEvent.click(tabs[0]);
    expect(screen.getByTestId("browser-view").textContent).toBe("http://localhost:3000/");
    // The agent's current page follows the pick.
    expect(focusBrowserPage).toHaveBeenCalledWith("p1");
  });
});
