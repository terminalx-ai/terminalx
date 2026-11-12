import "@testing-library/dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/menu";
import { ModelPickerEmpty } from "./ModelPickerEmpty";

afterEach(cleanup);

function open(props: Partial<React.ComponentProps<typeof ModelPickerEmpty>> = {}) {
  const onRetry = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>x</DropdownMenuTrigger>
      <DropdownMenuContent>
        <ModelPickerEmpty agent="Codex" signIn="ChatGPT" other="Claude Code" loading={false} retrying={false} onRetry={onRetry} onOpenSettings={onOpenSettings} {...props} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return { onRetry, onOpenSettings };
}

describe("an empty model list", () => {
  it("names the agent, explains, and offers both ways out", () => {
    const { onRetry, onOpenSettings } = open();
    expect(screen.getByText("No models from Codex")).toBeTruthy();
    expect(screen.getByText(/Codex answered with an empty model list/)).toBeTruthy();
    expect(screen.getByText(/Its ChatGPT sign-in may have expired/)).toBeTruthy();
    expect(screen.getByText(/Claude Code models still work/)).toBeTruthy();
    screen.getByRole("menuitem", { name: "Open Settings › Agents" }).click();
    expect(onOpenSettings).toHaveBeenCalled();
    screen.getByRole("menuitem", { name: "Retry" }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it("says it is loading, not empty, while the models load", () => {
    open({ loading: true });
    expect(screen.getByTestId("model-picker-loading").textContent).toContain("Loading Codex models");
    expect(screen.queryByText("No models from Codex")).toBeNull();
  });

  it("shows loading again while a retry is out", () => {
    open({ retrying: true });
    expect(screen.getByTestId("model-picker-loading")).toBeTruthy();
  });
});
