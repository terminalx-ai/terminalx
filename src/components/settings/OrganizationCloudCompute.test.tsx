import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { OrganizationCloudCompute } from "./OrganizationCloudCompute";

afterEach(cleanup);

const panels = {
  providers: <p>providers panel</p>,
  environment: <p data-testid="environment-row">environment panel</p>,
  limits: <p>limits panel</p>,
  agentLogins: <p>logins panel</p>,
};

it("shows Providers, Environment, Limits and Agent logins as tabs, one panel at a time, keeping the others mounted", () => {
  render(<OrganizationCloudCompute organizationName="Acme" panels={panels} />);
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Providers", "Environment", "Limits", "Agent logins"]);
  expect(screen.getByRole("tab", { name: "Providers" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("environment panel").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("tab", { name: "Environment" }));
  expect(screen.getByText("environment panel").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(false);
  expect(screen.getByText("providers panel").closest("[role=tabpanel]")!.hasAttribute("hidden")).toBe(true);
  fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Limits" }).getAttribute("aria-selected")).toBe("true");
});

it("opens the tab holding a row a settings link marks", async () => {
  render(<OrganizationCloudCompute organizationName="Acme" panels={panels} />);
  await act(async () => {
    screen.getByTestId("environment-row").dataset.settingHighlight = "on";
    await Promise.resolve();
  });
  expect(screen.getByRole("tab", { name: "Environment" }).getAttribute("aria-selected")).toBe("true");
});
