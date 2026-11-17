import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { OrganizationCloudCompute } from "./OrganizationCloudCompute";

vi.mock("@/lib/settingsFile", () => ({
  useSettingsFile: () => ({ error: null, file: null, revision: 0 }),
}));
// Replace account/backend loading, retaining the real caller and tab boundary.
vi.mock("./sectionRenderers", () => ({
  settingsSectionRenderers: {
    organizations: () => <OrganizationCloudCompute organizationName="Acme" panels={{
      providers: <p>Providers</p>,
      environment: <div data-setting-id="organizations.environment" style={{ display: "contents" }}>
        <section data-testid="environment-row">Environment settings</section>
      </div>,
      limits: <p>Limits</p>,
      agentLogins: <p>Agent logins</p>,
    }} />,
  },
}));

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["link", "search"])("focuses a hidden cloud row only after its tab opens through a %s", async (entry) => {
  const hiddenAtFocus: boolean[] = [];
  const nativeFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
    if (this.dataset.testid === "environment-row") hiddenAtFocus.push(!!this.closest("[hidden]"));
    nativeFocus.call(this, options);
  });
  const view = render(<SettingsPage initialTab="organizations" onBack={vi.fn()} />);
  const target = screen.getByTestId("environment-row");
  expect(target.closest("[hidden]")).not.toBeNull();
  if (entry === "link") {
    view.rerender(<SettingsPage initialTab="organizations.environment" openRequest={1} onBack={vi.fn()} />);
  } else {
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "environment" } });
    fireEvent.click(document.getElementById("settings-result-organizations.environment")!);
  }
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("environment-row")));
  expect(screen.getByRole("tab", { name: "Environment" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByTestId("environment-row").closest("[hidden]")).toBeNull();
  expect(hiddenAtFocus).toEqual([false]);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
});

it("preserves focus in an existing dialog when the linked cloud tab becomes visible", async () => {
  const view = render(<SettingsPage initialTab="organizations" onBack={vi.fn()} />);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  const button = document.createElement("button");
  dialog.append(button);
  document.body.append(dialog);
  button.focus();
  try {
    view.rerender(<SettingsPage initialTab="organizations.environment" openRequest={1} onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("environment-row").closest("[hidden]")).toBeNull());
    expect(document.activeElement).toBe(button);
  } finally {
    dialog.remove();
  }
});

it("reopens the same linked cloud row while its previous highlight is still active", async () => {
  vi.useFakeTimers();
  try {
    const onBack = vi.fn();
    const view = render(<SettingsPage initialTab="organizations" onBack={onBack} />);
    await act(async () => {
      view.rerender(<SettingsPage initialTab="organizations.environment" openRequest={1} onBack={onBack} />);
    });
    const target = screen.getByTestId("environment-row");
    expect(target.closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(target);
    const providers = screen.getByRole("tab", { name: "Providers" });
    fireEvent.click(providers);
    providers.focus();
    expect(target.closest("[hidden]")).not.toBeNull();
    expect(target.dataset.settingHighlight).toBe("on");

    await act(async () => {
      view.rerender(<SettingsPage initialTab="organizations.environment" openRequest={2} onBack={onBack} />);
    });
    expect(target.closest("[hidden]")).toBeNull();
    expect(document.activeElement).toBe(target);
    expect(target.dataset.settingHighlight).toBe("on");
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
