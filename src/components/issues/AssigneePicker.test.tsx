import "@testing-library/dom";
import { useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDetails, IssueUser } from "@/lib/issueOps";
import { createIssueOpsMock, type IssueOpsMock } from "@/test/issueOpsMock";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { AssigneePicker } = await import("./AssigneePicker");

let issues: IssueOpsMock;

beforeEach(() => {
  issues = createIssueOpsMock();
  invoke.mockReset();
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => issues.handle(command, args));
});

afterEach(cleanup);

/** The picker in a header that shows the issue each write answers with, as the Issues view does. */
function Header({ start, viewer = null, onChange }: { start: IssueDetails; viewer?: IssueUser | null; onChange?: (issue: IssueDetails) => void }) {
  const [issue, setIssue] = useState(start);
  return (
    <AssigneePicker
      projectPath="/repo"
      issue={issue}
      viewer={viewer}
      onChange={(next) => {
        setIssue(next);
        onChange?.(next);
      }}
    />
  );
}

const writes = () => issues.calls.filter((call) => call.command === "issue_set_assignees").map((call) => call.args.assignees);
const trigger = () => screen.getByRole("button", { name: /^(Assignees:|Assign$)/ });
async function openPicker() {
  fireEvent.click(trigger());
  return within(await screen.findByRole("listbox", { name: "Assignees" }));
}

describe("Linear: one assignee", () => {
  const linear = () => issues.issue("linear", "8a1c2e9e-0000-4000-8000-000000000042");

  it("reassigns, assigns to me and unassigns, showing what each write answered", async () => {
    render(<Header start={structuredClone(linear())} viewer={issues.viewer.linear} />);
    expect(trigger().getAttribute("aria-label")).toBe("Assignees: Sam");

    let list = await openPicker();
    expect(list.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["Sam", "Kim"]);
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBeNull();
    fireEvent.click(list.getByRole("option", { name: "Kim" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: Kim"));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(writes()).toEqual([["user-kim"]]);

    // The reader (Kim) has it now: "Assign to me" isn't offered, "Unassign" is.
    await openPicker();
    expect(screen.queryByRole("button", { name: "Assign to me" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unassign" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assign"));
    expect(trigger().textContent).toContain("Unassigned");
    expect(linear().assignees).toEqual([]);

    list = await openPicker();
    expect(screen.queryByRole("button", { name: "Unassign" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: Kim"));
    expect(writes()).toEqual([["user-kim"], [], ["user-kim"]]);
  });

  it("writes nothing when the current assignee is picked again", async () => {
    render(<Header start={structuredClone(linear())} />);
    const list = await openPicker();
    fireEvent.click(list.getByRole("option", { name: "Sam" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("GitHub: several assignees", () => {
  const github = () => issues.issue("github", "41");

  it("shows every assignee and ticks people on and off, one write each", async () => {
    render(<Header start={structuredClone(github())} viewer={issues.viewer.github} />);
    expect(trigger().getAttribute("aria-label")).toBe("Assignees: sam, alex");
    expect(screen.getByRole("img", { name: "sam, alex" })).toBeTruthy();

    const list = await openPicker();
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
    expect(list.getAllByRole("option").map((row) => [row.getAttribute("aria-label"), row.getAttribute("aria-selected")])).toEqual([
      ["sam", "true"],
      ["alex", "true"],
      ["kim", "false"],
    ]);

    fireEvent.click(list.getByRole("option", { name: "kim" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: sam, alex, kim"));
    // The picker stays open for the next tick.
    fireEvent.click(list.getByRole("option", { name: "sam" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: alex, kim"));
    expect(writes()).toEqual([["sam", "alex", "kim"], ["alex", "kim"]]);
    expect(github().assignees.map((person) => person.id)).toEqual(["alex", "kim"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assign"));
    expect(writes().at(-1)).toEqual([]);
  });

  it("adds the reader with Assign to me, beside who already has it", async () => {
    render(<Header start={structuredClone(github())} viewer={issues.viewer.github} />);
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: sam, alex, kim"));
    expect(screen.queryByRole("button", { name: "Assign to me" })).toBeNull();
  });

  it("offers only the repository's assignable people, and not the reader when they can't be assigned", async () => {
    const outsider: IssueUser = { id: "outsider", name: "outsider", login: "outsider" };
    render(<Header start={structuredClone(github())} viewer={outsider} />);
    const list = await openPicker();
    expect(list.queryByRole("option", { name: "outsider" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Assign to me" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search assignable people" }), { target: { value: "outsider" } });
    expect(list.queryAllByRole("option")).toHaveLength(0);
    expect(list.getByText("No one matches.")).toBeTruthy();
  });

  it("searches names and logins", async () => {
    issues.options.github.members.push({ id: "rhodes", name: "Ada Rhodes", login: "rhodes" });
    render(<Header start={structuredClone(github())} />);
    const list = await openPicker();
    const search = screen.getByRole("textbox", { name: "Search assignable people" });
    fireEvent.change(search, { target: { value: "ada" } });
    expect(list.getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["Ada Rhodes (@rhodes)"]);
    fireEvent.change(search, { target: { value: "rhod" } });
    expect(list.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(writes()).toEqual([["sam", "alex", "rhodes"]]));
  });

  it("holds back an 11th assignee and says why", async () => {
    const start = structuredClone(github());
    const ten = Array.from({ length: 10 }, (_, index): IssueUser => ({ id: `user${index}`, name: `user${index}`, login: `user${index}` }));
    issues.options.github.members = [...ten, { id: "eleventh", name: "eleventh", login: "eleventh" }];
    issues.issues.get("github:41")!.issue.assignees = ten;
    start.assignees = ten;
    render(<Header start={start} />);
    const list = await openPicker();
    expect(list.getByRole("option", { name: "eleventh" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(list.getByRole("option", { name: "eleventh" }));
    expect(screen.getByText("An issue can have up to 10 assignees.")).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it("says why a refused assignment was refused and shows the assignees the provider has", async () => {
    render(<Header start={structuredClone(github())} />);
    const list = await openPicker();
    issues.fail("issue_set_assignees", "forbidden");
    fireEvent.click(list.getByRole("option", { name: "kim" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Your account doesn't have permission to do that.");
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: sam, alex"));
    expect(list.getByRole("option", { name: "kim" }).getAttribute("aria-selected")).toBe("false");
    // The issue was read again rather than trusted to be what was shown before.
    expect(issues.calls.at(-1)?.command).toBe("issue_details");
  });

  it("shows what changed on the provider meanwhile when a write is refused", async () => {
    const changes: IssueDetails[] = [];
    render(<Header start={structuredClone(github())} onChange={(issue) => changes.push(issue)} />);
    const list = await openPicker();
    // Someone took alex off on the website; this write is then refused.
    issues.issues.get("github:41")!.issue.assignees = [issues.options.github.members[0]];
    issues.fail("issue_set_assignees", "other");
    fireEvent.click(list.getByRole("option", { name: "kim" }));
    await waitFor(() => expect(trigger().getAttribute("aria-label")).toBe("Assignees: sam"));
    expect(changes.at(-1)?.assignees.map((person) => person.id)).toEqual(["sam"]);
  });

  it("says when the people can't be read", async () => {
    issues.fail("issue_options", "not_signed_in");
    render(<Header start={structuredClone(github())} />);
    fireEvent.click(trigger());
    expect((await screen.findByRole("alert")).textContent).toContain("not signed in");
  });

  it("shows the write in flight and takes no other pick until it answers", async () => {
    let answer!: () => void;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command !== "issue_set_assignees") return issues.handle(command, args);
      return new Promise((resolve) => (answer = () => resolve(issues.handle(command, args))));
    });
    render(<Header start={structuredClone(github())} />);
    const list = await openPicker();
    fireEvent.click(list.getByRole("option", { name: "kim" }));
    expect(trigger().getAttribute("aria-label")).toBe("Assignees: sam, alex, kim");
    expect(list.getByRole("option", { name: "sam" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(list.getByRole("option", { name: "sam" }));
    await act(async () => answer());
    await waitFor(() => expect(list.getByRole("option", { name: "sam" }).getAttribute("aria-disabled")).toBeNull());
    expect(writes()).toEqual([["sam", "alex", "kim"]]);
  });
});
