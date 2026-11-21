import "@testing-library/dom";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationEventTrigger } from "@/types/automations";

const { sourcePreview, linearTeams, githubRepo, options, openUrl } = vi.hoisted(() => ({
  sourcePreview: vi.fn(),
  linearTeams: vi.fn(),
  githubRepo: vi.fn(),
  options: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@/lib/api", () => ({
  automationsApi: { sourcePreview },
  issues: { linearTeams, githubRepo },
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));
vi.mock("@/lib/issueOps", () => ({ issueOps: { options } }));

const { AutomationSourceFields, defaultLinearTrigger, defaultPullRequestTrigger, eventTriggerReady, eventTriggerSentence } = await import("./AutomationSourceFields");

let latest: AutomationEventTrigger | null = null;

function Harness({ initial }: { initial: AutomationEventTrigger }) {
  const [trigger, setTrigger] = useState(initial);
  latest = trigger;
  return <div className="grid grid-cols-2"><AutomationSourceFields projectPath="/repo" trigger={trigger} onChange={setTrigger} /></div>;
}

beforeEach(() => {
  latest = null;
  sourcePreview.mockReset();
  linearTeams.mockReset();
  githubRepo.mockReset();
  options.mockReset();
  linearTeams.mockResolvedValue([{ id: "team-1", key: "ENG", name: "Engineering" }, { id: "team-2", key: "OPS", name: "Ops" }]);
  options.mockResolvedValue({
    states: [{ id: "s-done", name: "Done", type: "completed", color: "", position: 3 }, { id: "s-review", name: "In Review", type: "started", color: "", position: 2 }],
    members: [{ id: "user-7", name: "Sam" }],
  });
  githubRepo.mockResolvedValue("acme/widgets");
});

afterEach(cleanup);

describe("Linear issue trigger", () => {
  it("picks the first team, previews what matches now and keeps the report choices", async () => {
    sourcePreview.mockResolvedValue([{ id: "u1", identifier: "ENG-1", title: "Fix login", url: "https://linear.app/x/ENG-1", detail: "Todo" }]);
    render(<Harness initial={defaultLinearTrigger()} />);

    await waitFor(() => expect(latest?.source).toMatchObject({ teamId: "team-1", teamName: "Engineering" }));
    expect(await screen.findByText("Fix login")).toBeTruthy();
    expect(screen.getByText("1 matching issue now")).toBeTruthy();
    expect(sourcePreview).toHaveBeenLastCalledWith("/repo", expect.objectContaining({ kind: "linearIssue", teamId: "team-1", state: "open" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Labels (any of)" }), { target: { value: "bot, urgent" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Assignee" }), { target: { value: "me" } });
    await screen.findByRole("option", { name: "In Review" });
    fireEvent.change(screen.getByRole("combobox", { name: "Move the issue to" }), { target: { value: "s-review" } });
    await waitFor(() => expect(sourcePreview).toHaveBeenLastCalledWith("/repo", expect.objectContaining({ labels: ["bot", "urgent"], assignee: "me" })));
    expect(latest?.source).toMatchObject({ report: { moveToStateId: "s-review", moveToStateName: "In Review", comment: true } });

    fireEvent.click(screen.getByText("Fix login"));
    expect(openUrl).toHaveBeenCalledWith("https://linear.app/x/ENG-1");
  });

  it("says when Linear cannot be read", async () => {
    linearTeams.mockRejectedValue(new Error("Linear is not connected"));
    render(<Harness initial={defaultLinearTrigger()} />);
    expect(await screen.findByText("Linear is not connected")).toBeTruthy();
    expect(sourcePreview).not.toHaveBeenCalled();
    expect(eventTriggerReady(latest!)).toBe(false);
  });
});

describe("GitHub pull request trigger", () => {
  it("fills the repository, chooses events and filters, and previews the open pull requests", async () => {
    sourcePreview.mockResolvedValue([{ id: "12", identifier: "#12", title: "Add cache", url: "https://github.com/acme/widgets/pull/12", detail: "cache → main" }]);
    render(<Harness initial={defaultPullRequestTrigger()} />);

    await waitFor(() => expect(latest?.source).toMatchObject({ repo: "acme/widgets" }));
    expect(await screen.findByText("Add cache")).toBeTruthy();
    expect(screen.getByText("1 matching pull request now")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Review requested from me" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Opened" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Base branch" }), { target: { value: "main" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Drafts" }), { target: { value: "false" } });
    await waitFor(() => expect(sourcePreview).toHaveBeenLastCalledWith("/repo", expect.objectContaining({ kind: "githubPullRequest", base: "main", draft: false, events: ["pushed", "reviewRequested"] })));

    fireEvent.click(screen.getByRole("checkbox", { name: "New commits pushed" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Review requested from me" }));
    expect(eventTriggerReady(latest!)).toBe(false);
  });

  it("keeps what is typed in a label list, commas and spaces too", async () => {
    sourcePreview.mockResolvedValue([]);
    render(<Harness initial={defaultPullRequestTrigger("acme/widgets")} />);
    const labels = screen.getByRole("textbox", { name: "Labels (all of)" }) as HTMLInputElement;
    fireEvent.change(labels, { target: { value: "bot," } });
    expect(labels.value).toBe("bot,");
    fireEvent.change(labels, { target: { value: "bot, needs review" } });
    expect(labels.value).toBe("bot, needs review");
    expect(latest?.source.labels).toEqual(["bot", "needs review"]);
  });

  it("leaves pull requests from forks out unless they are allowed, and warns when they are", async () => {
    sourcePreview.mockResolvedValue([]);
    render(<Harness initial={defaultPullRequestTrigger("acme/widgets")} />);
    expect(latest?.source).toMatchObject({ fromForks: false });
    expect(screen.queryByText(/Runs can work on outsiders' code/)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Also wake on pull requests from forks" }));
    expect(latest?.source).toMatchObject({ fromForks: true });
    expect(screen.getByText(/Runs can work on outsiders' code/)).toBeTruthy();
    await waitFor(() => expect(sourcePreview).toHaveBeenLastCalledWith("/repo", expect.objectContaining({ fromForks: true })));
  });

  it("describes each trigger in a sentence", () => {
    expect(eventTriggerSentence(defaultPullRequestTrigger("acme/widgets"))).toBe("GitHub pull requests in acme/widgets: opened, new commits pushed, checked every 5 min");
    const linear = defaultLinearTrigger();
    linear.source = { ...linear.source, kind: "linearIssue", teamName: "Engineering", labels: ["bot"] } as typeof linear.source;
    expect(eventTriggerSentence(linear)).toBe("Linear: new Engineering issues labelled bot, checked every 5 min");
  });
});

describe("runs a day (PRO-490)", () => {
  it("starts at 48, reads an automation saved before it as 48, and keeps what is typed within 1 to 1000", async () => {
    sourcePreview.mockResolvedValue([]);
    expect(defaultPullRequestTrigger().maxRunsPerDay).toBe(48);
    expect(defaultLinearTrigger().maxRunsPerDay).toBe(48);
    const { maxRunsPerDay: _, ...saved } = defaultPullRequestTrigger("acme/widgets");
    render(<Harness initial={saved} />);
    const field = screen.getByRole("spinbutton", { name: "Runs a day, at most" }) as HTMLInputElement;
    expect(field.value).toBe("48");
    fireEvent.change(field, { target: { value: "10" } });
    expect(latest?.maxRunsPerDay).toBe(10);
    fireEvent.change(field, { target: { value: "5000" } });
    expect(latest?.maxRunsPerDay).toBe(1000);
    fireEvent.change(field, { target: { value: "0" } });
    expect(latest?.maxRunsPerDay).toBe(1);
  });

  it("is not a duty's to set", () => {
    sourcePreview.mockResolvedValue([]);
    render(<div className="grid grid-cols-2"><AutomationSourceFields projectPath="/repo" trigger={defaultPullRequestTrigger("acme/widgets")} onChange={() => {}} forDuty /></div>);
    expect(screen.queryByRole("spinbutton", { name: "Runs a day, at most" })).toBeNull();
  });
});
