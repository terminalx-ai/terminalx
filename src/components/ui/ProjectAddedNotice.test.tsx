import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announceProjectAdded, dismissProjectAdded, onProjectSettingsRequest } from "@/lib/projectAdded";
import { ProjectAddedNotice } from "./ProjectAddedNotice";

afterEach(() => { act(() => dismissProjectAdded()); cleanup(); });

describe("Project added notice", () => {
  it("is absent until a project is added", () => {
    render(<ProjectAddedNotice />);
    expect(screen.queryByText("Project added")).toBeNull();
  });

  it("names the folder and opens the settings of the project just added", () => {
    const requested = vi.fn();
    const stop = onProjectSettingsRequest(requested);
    render(<ProjectAddedNotice />);
    act(() => announceProjectAdded({ path: "/Users/someone/code/procyon/server", name: "server" }));
    expect(screen.getByText("Project added")).toBeTruthy();
    expect(screen.getByText("~/code/procyon/server")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    expect(requested).toHaveBeenCalledExactlyOnceWith("/Users/someone/code/procyon/server");
    expect(screen.queryByText("Project added")).toBeNull();
    stop();
  });

  it("shows the latest addition, and can be dismissed", () => {
    render(<ProjectAddedNotice />);
    act(() => announceProjectAdded({ path: "/a", name: "a" }));
    act(() => announceProjectAdded({ path: "/b", name: "b" }));
    expect(screen.getAllByText("Project added")).toHaveLength(1);
    expect(screen.getByText("/b")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Project added")).toBeNull();
  });
});
