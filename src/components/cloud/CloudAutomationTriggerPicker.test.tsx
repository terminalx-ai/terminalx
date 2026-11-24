import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAutomationTriggerPicker } from "./CloudAutomationTriggerPicker";

afterEach(cleanup);

describe("CloudAutomationTriggerPicker", () => {
  it("offers only Schedule by default", () => {
    render(<CloudAutomationTriggerPicker value="timer" onChange={vi.fn()} />);

    const group = within(screen.getByRole("radiogroup", { name: "Trigger" }));
    const schedule = group.getByRole("radio", {
      name: "Schedule",
      description: "Hourly, daily, weekdays or weekly",
      checked: true,
    });
    expect(group.getAllByRole("radio")).toEqual([schedule]);
  });

  it("moves focus and the single selection between Schedule and ready GitHub with arrow keys", async () => {
    const onChange = vi.fn();
    function Form() {
      const [value, setValue] = useState<"timer" | "github" | "webhook">("timer");
      return <CloudAutomationTriggerPicker value={value} githubAvailable onChange={(next) => {
        onChange(next);
        setValue(next);
      }} />;
    }

    render(<Form />);
    const group = within(screen.getByRole("radiogroup", { name: "Trigger" }));
    const schedule = group.getByRole("radio", { name: "Schedule" });
    const github = group.getByRole("radio", {
      name: "GitHub event",
      description: "A PR is opened, pushed or merged",
    });
    expect(within(github).getByText("Cloud")).toBeTruthy();
    expect(group.getAllByRole("radio")).toEqual([schedule, github]);

    act(() => schedule.focus());
    fireEvent.keyDown(schedule, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(github));
    fireEvent.keyUp(github, { key: "ArrowDown" });
    expect(group.getAllByRole("radio", { checked: true })).toEqual([github]);

    fireEvent.keyDown(github, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(schedule));
    fireEvent.keyUp(schedule, { key: "ArrowUp" });
    expect(group.getAllByRole("radio", { checked: true })).toEqual([schedule]);
    expect(onChange.mock.calls).toEqual([["github"], ["timer"]]);
  });

  it("offers Webhook with its own readiness while GitHub is held", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CloudAutomationTriggerPicker value="timer" webhookAvailable onChange={onChange} />);
    const webhook = screen.getByRole("radio", { name: "Webhook", description: "Another tool posts JSON to a URL" });
    expect(screen.queryByRole("radio", { name: "GitHub event" })).toBeNull();
    fireEvent.click(webhook);
    expect(onChange.mock.calls).toEqual([["webhook"]]);

    rerender(<CloudAutomationTriggerPicker value="webhook" webhookAvailable onChange={onChange} />);
    expect(screen.getAllByRole("radio", { checked: true })).toEqual([webhook]);
  });

  it.each([
    { kind: "github", label: "GitHub event", readiness: { githubAvailable: true } },
    { kind: "webhook", label: "Webhook", readiness: { webhookAvailable: true } },
  ] as const)("drops a held $label choice without silently changing the draft", ({ kind, label, readiness }) => {
    const onChange = vi.fn();
    const { rerender } = render(<CloudAutomationTriggerPicker value={kind} {...readiness} onChange={onChange} />);
    expect(screen.getByRole("radio", { name: label, checked: true })).toBeTruthy();

    rerender(<CloudAutomationTriggerPicker value={kind} onChange={onChange} />);
    expect(screen.queryByRole("radio", { name: label })).toBeNull();
    expect(screen.queryByRole("radio", { checked: true })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("radio", { name: "Schedule" }));
    expect(onChange.mock.calls).toEqual([["timer"]]);
  });
});
