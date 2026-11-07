import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubAutomationTrigger } from "@/lib/api";
import { GithubTriggerEditor } from "./GithubTriggerEditor";
import { blankScheduleForm, scheduleInput, validGithubTrigger } from "@/lib/cloudSchedules";

afterEach(cleanup);
function Editor() {
  const [value, setValue] = useState<GithubAutomationTrigger>({ repositoryId: "", events: ["opened"], filters: [] });
  return <><GithubTriggerEditor value={value} repositories={[{ id: "selected-row", fullName: "synthetic/docs" }]} onChange={setValue} /><output data-testid="config">{JSON.stringify(value)}</output></>;
}
const config = () => JSON.parse(screen.getByTestId("config").textContent!) as GithubAutomationTrigger;
describe("GitHub trigger editor", () => {
  it("selects a connected repository and each explicit event without treating PR updates as branch pushes", () => {
    render(<Editor />);
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "selected-row" } });
    fireEvent.click(screen.getByLabelText("PR updated (new commits)"));
    fireEvent.click(screen.getByLabelText("PR merged"));
    fireEvent.click(screen.getByLabelText("Branch pushed"));
    expect(config()).toEqual({ repositoryId: "selected-row", events: ["opened", "synchronize", "merged", "push"], filters: [] });
    fireEvent.click(screen.getByLabelText("PR opened"));
    expect(config().events).not.toContain("opened");
  });
  it.each(["label", "author", "baseBranch"] as const)("serializes both operators for %s, removes filters, and requires values", (field) => {
    render(<Editor />);
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "selected-row" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(validGithubTrigger(config())).toBe(false);
    fireEvent.change(screen.getByLabelText("Filter 1 field"), { target: { value: field } });
    fireEvent.change(screen.getByLabelText("Filter 1 value"), { target: { value: "docs" } });
    expect(config().filters).toEqual([{ field, operator: "is", value: "docs" }]);
    fireEvent.change(screen.getByLabelText("Filter 1 operator"), { target: { value: "is-not" } });
    expect(config().filters).toEqual([{ field, operator: "is-not", value: "docs" }]);
    expect(validGithubTrigger(config())).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter 1" }));
    expect(config().filters).toEqual([]);
  });
  it("preserves mode and workspace authority and reserves space for event context", () => {
    const form = { ...blankScheduleForm(), name: "Review", prompt: "Review each new PR.", mode: "auto", githubTrigger: { repositoryId: "repo", events: ["opened" as const], filters: [] } };
    expect(scheduleInput(form, "configured-workspace")).toMatchObject({ workspaceId: "configured-workspace", mode: "auto", githubTrigger: form.githubTrigger, schedule: { preset: "hourly" } });
    expect(scheduleInput({ ...form, mode: "bypassPermissions" }, "configured-workspace")).toBeNull();
    expect(scheduleInput({ ...form, prompt: "a".repeat(16 * 1024 + 1) }, "configured-workspace")).toBeNull();
  });
});
