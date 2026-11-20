import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudScheduleGithubTrigger, CloudSelectedRepository } from "@/lib/api";
import { GithubTriggerEditor } from "./GithubTriggerEditor";

const repo = (fields: Partial<CloudSelectedRepository> = {}): CloudSelectedRepository => ({ id: "row-id", fullName: "org/app", cloneUrl: "https://github.com/org/app.git", defaultBranch: "main", private: true, state: "accessible", reason: null, ...fields });
function Editor({ repositories = [repo()] }: { repositories?: CloudSelectedRepository[] }) {
  const [value, setValue] = useState<CloudScheduleGithubTrigger>({ repositoryId: "", event: "opened", filters: [] });
  return <><GithubTriggerEditor value={value} repositories={repositories} onChange={setValue} /><output data-testid="trigger">{JSON.stringify(value)}</output></>;
}
const trigger = (): CloudScheduleGithubTrigger => JSON.parse(screen.getByTestId("trigger").textContent!);
afterEach(cleanup);

describe("accepted GitHub trigger editor", () => {
  it("selects only accessible organization repository row IDs and never fabricates IDs from names or URLs", () => {
    render(<Editor repositories={[repo(), repo({ id: undefined, fullName: "org/no-id" }), repo({ id: null, fullName: "org/null-id" }), repo({ id: "suspended", fullName: "org/suspended", state: "installation-suspended" })]} />);
    for (const name of ["org/no-id (repository ID unavailable)", "org/null-id (repository ID unavailable)", "org/suspended (unavailable)"]) {
      expect((screen.getByRole("option", { name }) as HTMLOptionElement).disabled).toBe(true);
    }
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "row-id" } });
    expect(trigger().repositoryId).toBe("row-id");
    expect(within(screen.getByRole("group", { name: "GitHub event trigger" })).queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("GitHub repository").textContent).not.toContain("https://");
  });

  it("offers exactly one opened/pushed/merged event, default forks off and explicit fork opt-in", () => {
    render(<Editor />);
    const event = screen.getByLabelText("GitHub event") as HTMLSelectElement;
    expect([...event.options].map((option) => option.value)).toEqual(["opened", "pushed", "merged"]);
    expect(event.multiple).toBe(false);
    expect((screen.getByLabelText("Allow pull requests from forks") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(event, { target: { value: "pushed" } });
    fireEvent.click(screen.getByLabelText("Allow pull requests from forks"));
    expect(trigger()).toEqual({ repositoryId: "", event: "pushed", filters: [], allowForkPullRequests: true });
    fireEvent.click(screen.getByLabelText("Allow pull requests from forks"));
    expect(trigger().allowForkPullRequests).toBe(false);
    expect(screen.getByText(/untrusted fork PR metadata/)).toBeTruthy();
  });

  it("limits filters to five AND conditions with exact field/operator choices and supports removal", () => {
    render(<Editor />);
    for (let index = 1; index <= 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
      fireEvent.change(screen.getByLabelText(`Filter ${index} value`), { target: { value: "main" } });
    }
    expect((screen.getByRole("button", { name: "Add filter" }) as HTMLButtonElement).disabled).toBe(true);
    expect(trigger().filters).toHaveLength(5);
    expect([...(screen.getByLabelText("Filter 1 field") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["label", "author", "baseBranch"]);
    expect([...(screen.getByLabelText("Filter 1 operator") as HTMLSelectElement).options].map((option) => option.value)).toEqual(["is", "is-not"]);
    fireEvent.change(screen.getByLabelText("Filter 1 field"), { target: { value: "baseBranch" } });
    fireEvent.change(screen.getByLabelText("Filter 1 operator"), { target: { value: "is-not" } });
    expect(trigger().filters[0]).toEqual({ field: "baseBranch", operator: "is-not", value: "main" });
    fireEvent.click(screen.getByRole("button", { name: "Remove filter 2" }));
    expect(trigger().filters).toHaveLength(4);
    expect((screen.getByRole("button", { name: "Add filter" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Both label operators exclude pushes/)).toBeTruthy();
  });

  it.each(["   ", "bad\u0001value", "bad\u007fvalue", "😀".repeat(128)])("renders validation for invalid filter value %j", (value) => {
    render(<Editor />);
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "row-id" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.change(screen.getByLabelText("Filter 1 value"), { target: { value } });
    expect(within(screen.getByRole("group", { name: "GitHub event trigger" })).getByRole("status").textContent).toContain("255 UTF-16 units without control characters");
  });
});
