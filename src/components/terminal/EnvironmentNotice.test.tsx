import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const { changed } = vi.hoisted(() => ({ changed: vi.fn() }));
vi.mock("@/lib/localEnvironment", () => ({ environment: { changed } }));
import { EnvironmentNotice } from "./EnvironmentNotice";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("environment restart notice", () => {
  it("refreshes after a save and clears after a new launch without restarting anything", async () => {
    changed.mockResolvedValue({ changed: false, unavailable: false });
    render(<EnvironmentNotice id="tab:a" />);
    await waitFor(() => expect(changed).toHaveBeenCalledWith("tab:a"));
    expect(screen.queryByRole("status")).toBeNull();
    changed.mockResolvedValue({ changed: true, unavailable: false });
    act(() => { window.dispatchEvent(new Event("local-environment-changed")); });
    expect((await screen.findByRole("status")).textContent).toContain("Restart to apply");
    changed.mockResolvedValue({ changed: false, unavailable: false });
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
  it("explains that a failed read omitted overrides without stopping the tab", async () => {
    changed.mockResolvedValue({ changed: true, unavailable: true });
    render(<EnvironmentNotice id="tab:unavailable" />);
    expect((await screen.findByRole("status")).textContent).toContain("started without environment overrides");
  });
  it("ignores a response from a previously selected tab and skips hidden tabs", async () => {
    let resolve!: (value: { changed: boolean; unavailable: boolean }) => void;
    changed.mockImplementationOnce(() => new Promise<{ changed: boolean; unavailable: boolean }>((done) => { resolve = done; })).mockResolvedValue({ changed: false, unavailable: false });
    const view = render(<EnvironmentNotice id="tab:a" />);
    view.rerender(<EnvironmentNotice id="tab:b" />);
    await act(async () => { resolve({ changed: true, unavailable: false }); });
    expect(screen.queryByRole("status")).toBeNull();
    changed.mockClear();
    view.rerender(<EnvironmentNotice id="tab:b" active={false} />);
    act(() => { window.dispatchEvent(new Event("local-environment-changed")); });
    expect(changed).not.toHaveBeenCalled();
  });
});
