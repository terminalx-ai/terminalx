import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OrganizationCloudCompute } from "./OrganizationCloudCompute";

afterEach(cleanup);

// Environment and Agent logins are pages of their own in the Settings menu (PRO-464).
const panels = {
  providers: <p>providers panel</p>,
  limits: <p data-testid="limits-row">limits panel</p>,
};

it("shows Providers and Limits as tabs, one panel at a time, keeping the other mounted", () => {
  render(<OrganizationCloudCompute organizationName="Acme" panels={panels} />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Providers", "Limits"]);
  expect(screen.getByRole("tab", { name: "Providers" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("limits panel").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Limits" }));
  expect(screen.getByText("limits panel").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(false);
  expect(screen.getByText("providers panel").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Providers" }).getAttribute("aria-selected")).toBe("true");
});

it("opens the tab holding a row a settings link marks", async () => {
  render(<OrganizationCloudCompute organizationName="Acme" panels={panels} />);
  await act(async () => {
    screen.getByTestId("limits-row").dataset.settingHighlight = "on";
    await Promise.resolve();
  });
  expect(screen.getByRole("tab", { name: "Limits" }).getAttribute("aria-selected")).toBe("true");
});
