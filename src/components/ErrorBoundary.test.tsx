import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorScreen, ErrorBoundary } from "./ErrorBoundary";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

function Broken(): never {
  throw new Error("the app shell could not render");
}

describe("the app's error screen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows what failed and a Reload button when the app itself cannot render", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <ErrorBoundary label="TerminalX" fallback={(error) => <AppErrorScreen error={error} reload={reload} />}>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("TerminalX could not show its window.");
    expect(screen.getByRole("alert").textContent).toContain("the app shell could not render");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("names a startup failure that is not an Error", () => {
    render(<AppErrorScreen error="the settings file could not be read" reload={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("the settings file could not be read");
  });

  it("still draws a pane's own error in place, with Try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="the editor">
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong in the editor.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
