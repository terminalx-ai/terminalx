// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fs, type LocalPathInfo } from "@/lib/api";
import { ChatLink } from "./ChatLink";

vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
vi.mock("@/lib/editors", () => ({ fileKind: () => "text", openFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn(), revealItemInDir: vi.fn() }));

const context = { sessionId: "session", cwd: "/workspace" };
const local = (path: string): LocalPathInfo => ({ path, root: "/tmp", rel: path.split("/").pop()!, kind: "file", text: true });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("chat link actions", () => {
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
    expect(await screen.findByRole("menuitem", { name: "Open internally" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in default browser" }));
    expect((await screen.findByRole("alert")).textContent).toContain("No registered browser");
  });
});
