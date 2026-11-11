import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { Goal } from "@/types/events";
import { GoalBanner } from "./GoalBanner";

afterEach(cleanup);
const goal: Goal = { objective: "Reduce p95 latency below 120 ms", status: "active", tokenBudget: 1000, tokensUsed: 250 };

it("shows the objective, reported status and budget, then follows new snapshots", () => {
  const view = render(<GoalBanner goal={goal} />);
  expect(screen.getByRole("region", { name: "Codex goal" }).textContent).toContain(goal.objective);
  expect(screen.getByText("Active")).toBeDefined();
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("250");
  expect(screen.getByRole("meter").getAttribute("aria-valuemax")).toBe("1000");

  view.rerender(<GoalBanner goal={{ ...goal, status: "paused", tokensUsed: 800 }} />);
  expect(screen.getByText("Paused")).toBeDefined();
  expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("800");
  expect(screen.getByRole("meter").firstElementChild?.getAttribute("style")).toContain("80%");
});

it.each<[Goal["status"], string]>([
  ["complete", "Done"], ["blocked", "Blocked"], ["budgetLimited", "Budget reached"], ["usageLimited", "Usage limited"],
])("reports %s without inferring completion", (status, label) => {
  render(<GoalBanner goal={{ ...goal, status }} />);
  expect(screen.getByText(label)).toBeDefined();
});

it("caps the meter while retaining usage beyond the budget", () => {
  render(<GoalBanner goal={{ ...goal, tokensUsed: 1250, status: "budgetLimited" }} />);
  const meter = screen.getByRole("meter");
  expect(meter.getAttribute("aria-valuenow")).toBe("1000");
  expect(meter.getAttribute("aria-valuetext")).toBe(`${(1250).toLocaleString()} / ${(1000).toLocaleString()} tokens`);
  expect(meter.firstElementChild?.getAttribute("style")).toContain("100%");
});

it.each([null, 0])("does not fabricate a budget when it is %s", (tokenBudget) => {
  render(<GoalBanner goal={{ ...goal, tokenBudget }} />);
  expect(screen.queryByRole("meter")).toBeNull();
  expect(screen.getByText("250 tokens used · No token budget")).toBeDefined();
});

it("renders the objective as text, including markup", () => {
  const objective = '<img src="x" onerror="alert(1)">';
  const view = render(<GoalBanner goal={{ ...goal, objective }} />);
  expect(screen.getByText(objective)).toBeDefined();
  expect(view.container.querySelector("img")).toBeNull();
});
