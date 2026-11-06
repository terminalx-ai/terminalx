import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { changed } = vi.hoisted(() => ({ changed: vi.fn() }));
vi.mock("@/lib/localEnvironment", () => ({ environment: { changed } }));
import { EnvironmentNotice } from "./EnvironmentNotice";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("environment restart notice", () => {
  it("refreshes after a save and clears after a new launch without restarting anything", async () => {
    changed.mockResolvedValue(false);
    render(<EnvironmentNotice id="tab:a" />);
    await waitFor(() => expect(changed).toHaveBeenCalledWith("tab:a"));
    expect(screen.queryByRole("status")).toBeNull();
    changed.mockResolvedValue(true);
    act(() => { window.dispatchEvent(new Event("local-environment-changed")); });
    expect((await screen.findByRole("status")).textContent).toContain("Restart to apply");
    changed.mockResolvedValue(false);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
  it("ignores a response from a previously selected tab and skips hidden tabs", async () => {
    let resolve!: (value: boolean) => void;
    changed.mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; })).mockResolvedValue(false);
    const view = render(<EnvironmentNotice id="tab:a" />);
    view.rerender(<EnvironmentNotice id="tab:b" />);
    await act(async () => { resolve(true); });
    expect(screen.queryByRole("status")).toBeNull();
    changed.mockClear();
    view.rerender(<EnvironmentNotice id="tab:b" active={false} />);
    act(() => { window.dispatchEvent(new Event("local-environment-changed")); });
    expect(changed).not.toHaveBeenCalled();
  });
});
