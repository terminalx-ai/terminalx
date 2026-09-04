import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceNameEditor } from "./WorkspaceNameEditor";

afterEach(cleanup);

function EditableName({ onCommit = (name: string) => name }: { onCommit?: (name: string) => string | Promise<string> }) {
  const [name, setName] = useState("quiet-amber-fox");
  return (
    <WorkspaceNameEditor
      value={name}
      onCommit={async (requested) => {
        const canonical = await onCommit(requested);
        setName(canonical);
        return canonical;
      }}
    />
  );
}

describe("WorkspaceNameEditor", () => {
  it("edits on double-click and commits with Enter", async () => {
    const commit = vi.fn((name: string) => name.toLowerCase().replaceAll(" ", "-"));
    render(<EditableName onCommit={commit} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: /Workspace quiet-amber-fox/ }));
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(input, { target: { value: "Better Workspace" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(commit).toHaveBeenCalledWith("Better Workspace"));
    expect(await screen.findByRole("button", { name: /Workspace better-workspace/ })).toBeTruthy();
  });

  it("cancels with Escape without committing", () => {
    const commit = vi.fn((name: string) => name);
    render(<EditableName onCommit={commit} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: /Workspace quiet-amber-fox/ }));
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(input, { target: { value: "discard-this" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Workspace quiet-amber-fox/ })).toBeTruthy();
  });
});
