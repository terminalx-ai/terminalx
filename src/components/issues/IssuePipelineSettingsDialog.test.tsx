import "@testing-library/dom";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuePipelineSettings } from "@/types/issuePipeline";
import type { Project, ProjectPatch } from "@/types/session";
import type { CloudProject } from "@/types/target";

const { updateProject } = vi.hoisted(() => ({ updateProject: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/notify", () => ({ notePipelineState: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ updateProject }));

const { CloudIssuePipelineSettingsDialog, IssuePipelineSettingsDialog } = await import("./IssuePipelineSettingsDialog");
const { getPrefs, setPrefs } = await import("@/lib/prefs");

// As the app fills in a project that set nothing: no choice made for the launch switches.
const defaults: IssuePipelineSettings = {
  enabled: true, maxResolutions: 3, requirePerson: false, maxRounds: 3, mergeMethod: "merge",
  protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [],
};
/** Which choice a launch switch's default shows. */
const shown = (name: string) => within(screen.getByRole("radiogroup", { name })).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent;
const project = (issuePipeline?: IssuePipelineSettings): Project => ({ path: "/repo", name: "Widgets", issuePipeline });
/** What was last sent to be saved. */
const saved = () => (updateProject.mock.calls.at(-1) as [string, ProjectPatch])[1].issuePipeline;

beforeEach(() => {
  updateProject.mockReset();
  updateProject.mockImplementation(async (path: string, patch: ProjectPatch) => ({ ...project(), path, ...patch }));
});

afterEach(cleanup);

describe("a project's issue pipeline settings", () => {
  it("asks before agents update issues until the project lets them, and saves that on its own", async () => {
    const { rerender } = render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={() => {}} />);
    const toggle = () => screen.getByRole("switch", { name: "Agents comment and change status without asking" });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith("/repo", { agentIssueUpdates: true }));
    rerender(<IssuePipelineSettingsDialog project={{ ...project(), agentIssueUpdates: true }} open onOpenChange={() => {}} />);
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    // Independent of the pipeline: it can be changed with the pipeline off.
    rerender(<IssuePipelineSettingsDialog project={{ ...project({ ...defaults, enabled: false }), agentIssueUpdates: true }} open onOpenChange={() => {}} />);
    expect(toggle().hasAttribute("disabled")).toBe(false);
  });

  it("puts the switch back and says why when it cannot be saved", async () => {
    updateProject.mockRejectedValueOnce(new Error("The project is no longer attached."));
    render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Agents comment and change status without asking" }));
    expect(await screen.findByText("The project is no longer attached.")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Agents comment and change status without asking" }).getAttribute("aria-checked")).toBe("false");
  });

  it("shows the defaults for a project that set nothing, and saves a change at once", async () => {
    render(<IssuePipelineSettingsDialog project={project()} open onOpenChange={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Issue pipeline · Widgets" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Open a pull request and review it" }).getAttribute("aria-checked")).toBe("true");
    expect(shown("Merge automatically by default")).toBe("From issues");
    expect(shown("Resolve conflicts automatically by default")).toBe("From issues");
    expect(within(screen.getByRole("radiogroup", { name: "Review rounds" })).getByRole("radio", { name: "3" }).getAttribute("aria-checked")).toBe("true");
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
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Review rounds" })).getByRole("radio", { name: "5" }));
    expect(updateProject).toHaveBeenCalledTimes(2);
    // The second save carries the first change too: it does not put the switch back.
    expect(saved()).toEqual({ ...defaults, requirePerson: true, maxRounds: 5 });
    finish({ ...project({ ...defaults, requirePerson: true }) });
    await waitFor(() => expect(within(screen.getByRole("radiogroup", { name: "Review rounds" })).getByRole("radio", { name: "5" }).getAttribute("aria-checked")).toBe("true"));
  });

  it.each([["left to its default", undefined], ["turned on", true]])("holds the default off, and says nothing can merge, where a person does the merge, with the switch %s", (_, autoMerge) => {
    render(<IssuePipelineSettingsDialog project={project({ ...defaults, autoMerge, requirePerson: true })} open onOpenChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Merge automatically by default" }).getAttribute("aria-disabled")).toBe("true");
    expect(shown("Merge automatically by default")).toBe("Off");
    expect(screen.getByRole("switch", { name: "A person does the merge" }).getAttribute("aria-checked")).toBe("true");
  });

  // #700: left alone, issue sessions start with both on; a project can keep them off, or on for every session.
  it.each([
    ["Off", false],
    ["All sessions", true],
  ] as const)("stores %s as the project's own choice, and From issues as none", async (label, choice) => {
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
    const choose = async (name: string, option: string) => {
      fireEvent.click(within(screen.getByRole("radiogroup", { name })).getByRole("radio", { name: option }));
      await waitFor(() => expect(shown(name)).toBe(option));
    };
    await choose("Merge automatically by default", label);
    await choose("Resolve conflicts automatically by default", label);
    expect(saved()).toEqual({ ...defaults, autoMerge: choice, resolveConflicts: choice });
    await choose("Merge automatically by default", "From issues");
    expect(saved()?.autoMerge).toBeUndefined();
    expect(saved()?.resolveConflicts).toBe(choice);
  });

  it("greys out the pipeline's settings but its own switch when the pipeline is off", () => {
    render(<IssuePipelineSettingsDialog project={project({ ...defaults, enabled: false })} open onOpenChange={() => {}} />);
    const agents = screen.getByRole("switch", { name: "Agents comment and change status without asking" });
    const switches = screen.getAllByRole("switch").filter((toggle) => toggle !== agents);
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

describe("a cloud project's issue pipeline settings", () => {
  const cloud: CloudProject = { key: "cloud:org-1:github.com/acme/api", orgId: "org-1", identity: "github.com/acme/api", fullName: "acme/api", selected: true, pinned: false, blank: false, workspaces: [] };
  beforeEach(() => setPrefs({ cloudIssuePipelines: {} }));

  it("starts issue sessions resolving conflicts until the project turns it off, and keeps that choice", async () => {
    render(<CloudIssuePipelineSettingsDialog project={cloud} open onOpenChange={() => {}} />);
    expect(shown("Resolve conflicts automatically by default")).toBe("From issues");
    // A cloud workspace never merges by itself: there is nothing to choose for that.
    expect(screen.queryByRole("radiogroup", { name: "Merge automatically by default" })).toBeNull();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Resolve conflicts automatically by default" })).getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(shown("Resolve conflicts automatically by default")).toBe("Off"));
    expect(getPrefs().cloudIssuePipelines[cloud.key].resolveConflicts).toBe(false);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Resolve conflicts automatically by default" })).getByRole("radio", { name: "From issues" }));
    await waitFor(() => expect(shown("Resolve conflicts automatically by default")).toBe("From issues"));
    expect(getPrefs().cloudIssuePipelines[cloud.key].resolveConflicts).toBeUndefined();
  });
});
