import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [] }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./ProjectRail", () => ({ ProjectRail: () => <nav data-testid="project-tree" /> }));

const { Sidebar } = await import("./Sidebar");

afterEach(cleanup);

describe("Sidebar", () => {
  it("renders navigation as one sidebar surface", () => {
    const { container } = render(
      <Sidebar
        onToggle={() => {}}
        onOpenSettings={() => {}}
        onOpenAccount={() => {}}
        onOpenIssues={() => {}}
        onOpenAgents={() => {}}
        onOpenStats={() => {}}
        onOpenAutomations={() => {}}
        onOpenSkills={() => {}}
        onSearch={() => {}}
      />,
    );

    expect(screen.getByTestId("project-tree")).toBeTruthy();
    expect(container.querySelectorAll("aside")).toHaveLength(1);
    expect(container.querySelector("aside")?.className).toContain("w-(--sidebar-w)");
  });
});
