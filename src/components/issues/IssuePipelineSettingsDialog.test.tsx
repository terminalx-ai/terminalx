import "@testing-library/dom";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuePipelineSettings } from "@/types/issuePipeline";
import type { Project, ProjectPatch } from "@/types/session";

const { updateProject } = vi.hoisted(() => ({ updateProject: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ updateProject }));

const { IssuePipelineSettingsDialog } = await import("./IssuePipelineSettingsDialog");

const defaults: IssuePipelineSettings = {
  enabled: true, autoMerge: false, requirePerson: false, maxRounds: 3, mergeMethod: "merge",
  protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [],
};
const project = (issuePipeline?: IssuePipelineSettings): Project => ({ path: "/repo", name: "Widgets", issuePipeline });
/** What was last sent to be saved. */
const saved = () => (updateProject.mock.calls.at(-1) as [string, ProjectPatch])[1].issuePipeline;

beforeEach(() => {
  updateProject.mockReset();
  updateProject.mockImplementation(async (path: string, patch: ProjectPatch) => ({ ...project(), path, ...patch }));
});

afterEach(cleanup);

describe("a project's issue pipeline settings", () => {
  it("shows the defaults for a project that set nothing, and saves a change at once", async () => {
    render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Issue pipeline · Widgets" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Open a pull request and review it" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Merge automatically by default" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "3" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Merge commit" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Squash" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith("/repo", { issuePipeline: { ...defaults, mergeMethod: "squash" } }));
  });

  it("builds a second change on the first while the first is still being saved", async () => {
    let finish: (value: Project) => void = () => {};
    updateProject.mockImplementationOnce(() => new Promise<Project>((resolve) => (finish = resolve)));
    render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "A person does the merge" }));
    // Shown as chosen before the app has answered.
    expect(screen.getByRole("switch", { name: "A person does the merge" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "5" }));
    expect(updateProject).toHaveBeenCalledTimes(2);
    // The second save carries the first change too: it does not put the switch back.
    expect(saved()).toEqual({ ...defaults, requirePerson: true, maxRounds: 5 });
    finish({ ...project({ ...defaults, requirePerson: true }) });
    await waitFor(() => expect(screen.getByRole("radio", { name: "5" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("holds the default off, and says nothing can merge, where a person does the merge", () => {
    render(<IssuePipelineSettingsDialog project={project({ ...defaults, autoMerge: true, requirePerson: true })} open onOpenChange={() => {}} />);
    expect(screen.getByRole("switch", { name: "Merge automatically by default" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("switch", { name: "A person does the merge" }).getAttribute("aria-checked")).toBe("true");
  });

  it("greys out everything but the first switch when the pipeline is off", () => {
    render(<IssuePipelineSettingsDialog project={project({ ...defaults, enabled: false })} open onOpenChange={() => {}} />);
    const switches = screen.getAllByRole("switch");
    expect(switches[0].hasAttribute("disabled")).toBe(false);
    expect(switches.slice(1).every((toggle) => toggle.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("textbox", { name: "Protected paths" }).hasAttribute("disabled")).toBe(true);
  });

  it("saves the two lists when a box is left, one entry per line", async () => {
    // As in the app: a save comes back as the project the dialog is then shown for.
    let show: (next: Project) => void = () => {};
    function Shown() {
      const [current, setCurrent] = useState(project());
      show = setCurrent;
      return <IssuePipelineSettingsDialog project={current} open onOpenChange={() => {}} />;
    }
    updateProject.mockImplementation(async (path: string, patch: ProjectPatch) => {
      const next = { ...project(), path, ...patch };
      act(() => show(next));
      return next;
    });
    render(<Shown />);
    const paths = screen.getByRole("textbox", { name: "Protected paths" });
    fireEvent.change(paths, { target: { value: "saas/src/billing/\n\n  *.plist  \n" } });
    fireEvent.blur(paths);
    await waitFor(() => expect(saved()?.protected.paths).toEqual(["saas/src/billing/", "*.plist"]));
    const ignored = screen.getByRole("textbox", { name: "Checks that never hold a merge" });
    fireEvent.change(ignored, { target: { value: "windows-latest, flaky-e2e\nnightly" } });
    fireEvent.blur(ignored);
    await waitFor(() => expect(saved()?.ignoredChecks).toEqual(["windows-latest", "flaky-e2e", "nightly"]));
    expect(saved()?.protected.paths).toEqual(["saas/src/billing/", "*.plist"]);
    // Leaving a box without changing it saves nothing.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Checks that never hold a merge" })).toBeTruthy());
    const calls = updateProject.mock.calls.length;
    fireEvent.blur(ignored);
    fireEvent.blur(paths);
    expect(updateProject).toHaveBeenCalledTimes(calls);
  });

  it("does not drop what was typed when the dialog is closed from inside a box", async () => {
    const onOpenChange = vi.fn();
    render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={onOpenChange} />);
    const paths = screen.getByRole("textbox", { name: "Protected paths" });
    fireEvent.change(paths, { target: { value: "db/" } });
    // Escape, with the cursor still in the box: no blur comes first.
    fireEvent.keyDown(paths, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(updateProject).toHaveBeenCalledWith("/repo", { issuePipeline: { ...defaults, protected: { ...defaults.protected, paths: ["db/"] } } });
  });

  it("says when a change could not be saved, and shows what the project still holds", async () => {
    updateProject.mockRejectedValueOnce("projects.json is read-only");
    render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "A person does the merge" }));
    expect(await screen.findByText("projects.json is read-only")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "A person does the merge" }).getAttribute("aria-checked")).toBe("false");
  });
});
