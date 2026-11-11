import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewThreadCard } from "./ReviewThreads";
import { reviewThread, reviewSnapshot } from "@/test/reviewThreads";
import { fs } from "@/lib/api";
import { openUrl } from "@tauri-apps/plugin-opener";

vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "light" }) }));
vi.mock("@/lib/api", () => ({ fs: { inspectPath: vi.fn(), openPath: vi.fn() } }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [] }) }));
vi.mock("@/lib/browser", () => ({ openBrowserTab: vi.fn() }));
vi.mock("@/lib/editors", () => ({ fileKind: () => "text", openFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(), revealItemInDir: vi.fn() }));
afterEach(cleanup);

it("renders third-party threads without remote images or local/application links", () => {
  const body = '![tracking](https://untrusted.example/pixel) [app](/Applications/Utility.app) [file](file:///Users/me/Downloads/run.command) [scheme](terminalx://open) [web](https://example.com)\n\n`file:///Applications/Utility.app`\n\n```text\nfile:///Users/me/Downloads/run.command\n```';
  const { container } = render(<ReviewThreadCard thread={{ ...reviewThread, comments: [{ ...reviewThread.comments[0], body }] }} prUrl={reviewSnapshot.url} disabled={false} errorMessage={String} onResolve={vi.fn()} onReply={vi.fn()} />);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["web"]);
  fireEvent.click(screen.getByText("app"));
  fireEvent.click(screen.getByText(/^file \[blocked\]$/));
  fireEvent.click(screen.getByText(/^scheme \[blocked\]$/));
  expect(fs.openPath).not.toHaveBeenCalled();
  expect(fs.inspectPath).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
});
