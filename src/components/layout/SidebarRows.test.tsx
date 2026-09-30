import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTabRow, BrowserTabRow, DiffStats, ShellTabRow, TreeGroup, TreeNode, TreeRow, TreeToggle } from "./SidebarRows";

afterEach(cleanup);

// The row pieces take plain values and callbacks, so any tree section can
// draw its own records with them without a session store or backend.
describe("sidebar row building blocks", () => {
  it("draws a node from plain values and toggles through its callback", () => {
    const onToggle = vi.fn();
    render(
      <TreeNode label="fix-login" expanded={false}>
        <TreeRow level="group" selected={false} title="fix-login">
          <TreeToggle expanded={false} label="fix-login" onToggle={onToggle} />
          <DiffStats additions={3} deletions={0} unpushed={1} />
        </TreeRow>
        <TreeGroup expanded={false} className="pl-2">child</TreeGroup>
      </TreeNode>,
    );
    const node = screen.getByRole("treeitem", { name: "fix-login" });
    expect(node.getAttribute("aria-expanded")).toBe("false");
    expect(node.querySelector('[role="group"]')?.hasAttribute("hidden")).toBe(true);
    expect(screen.getByText("+3")).toBeTruthy();
    expect(screen.getByTitle("1 unpushed commit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand fix-login" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("opens tab rows from pointer or keyboard and closes them from the button or a middle click", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <div role="tree">
        <AgentTabRow nodeId="a" panelId="pa" harness="claude" label="Fix login" status="waiting" mobileDriven={false} terminalView={false} selected onOpen={onOpen} onClose={onClose} />
        <ShellTabRow nodeId="s" panelId="ps" title="Terminal 1" exited selected={false} onOpen={onOpen} onClose={onClose} />
        <BrowserTabRow nodeId="b" panelId="pb" label="Docs" url="https://example.com" agentTarget selected={false} onOpen={onOpen} onClose={onClose} />
      </div>,
    );
    const agent = screen.getByRole("treeitem", { name: "Fix login", selected: true });
    expect(agent.getAttribute("title")).toBe("Fix login · Needs attention");
    fireEvent.keyDown(agent, { key: "Enter" });
    fireEvent.click(screen.getByRole("treeitem", { name: "Terminal 1, exited" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close Docs browser page" }));
    fireEvent(screen.getByRole("treeitem", { name: "Docs browser page" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
