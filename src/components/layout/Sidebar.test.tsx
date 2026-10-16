import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useShortcut: vi.fn(), useShortcutKeys: () => [], useShortcutKeycaps: () => () => [] }));
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

describe("the sidebar's width", () => {
  it("follows the drag of its right edge, within bounds, and keeps the width once the pointer is up", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const prefs = await import("@/lib/prefs");
    prefs.setPrefs({ sidebarWidth: 268 });
    render(
      <Sidebar onToggle={() => {}} onOpenSettings={() => {}} onOpenAccount={() => {}} onOpenIssues={() => {}} onOpenAgents={() => {}} onOpenStats={() => {}} onOpenAutomations={() => {}} onOpenSkills={() => {}} onSearch={() => {}} />,
    );
    const handle = screen.getByRole("separator", { name: "Resize sidebar" });
    handle.setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { clientX: 268, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(document.documentElement.style.getPropertyValue("--sidebar-w")).toBe("400px");
    // Nothing is kept until the pointer is let go.
    expect(prefs.getPrefs().sidebarWidth).toBe(268);
    fireEvent.pointerUp(handle, { clientX: 2000, pointerId: 1 });
    expect(prefs.getPrefs().sidebarWidth).toBe(560);
    expect(document.documentElement.style.getPropertyValue("--sidebar-w")).toBe("560px");
  });
});
