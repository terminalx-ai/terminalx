import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TeamSurfaceExample, type TeamPreviewData } from "./TeamSurfaceExamples";
import { surfaceIds, surfaceMessage, surfaceStatuses, teamSurfaceDesigns } from "./teamSurfaceStates";

afterEach(cleanup);
const data: TeamPreviewData = {
  people: [{ id: "member", name: "Review member", presence: "unknown" }],
  workspace: "Review workspace", organization: "Review organization", plan: "Returned plan label", automation: "Review automation", port: 5173, remotePort: 3000, forwardState: "forwarded",
};

function openSurface(surface: string) {
  if (surface === "profile") fireEvent.click(screen.getByRole("button", { name: "Open profile" }));
  if (surface === "ports") fireEvent.click(screen.getByRole("button", { name: "Forward ports" }));
  if (surface === "share") fireEvent.click(screen.getByRole("button", { name: "Review Share dialog" }));
}

for (const surface of surfaceIds) {
  describe(teamSurfaceDesigns[surface].title, () => {
    for (const state of surfaceStatuses) {
      it(`renders the ${state} design without retaining private ready data or firing an action`, () => {
        const onAction = vi.fn();
        render(<TeamSurfaceExample surface={surface} data={data} state={state} canAct onAction={onAction} />);
        openSurface(surface);
        const message = surfaceMessage(surface, state);
        expect(screen.getByRole(state === "error" ? "alert" : "status").textContent).toContain(message.title);
        expect(screen.getByText(message.description)).toBeTruthy();
        expect(screen.queryByText(data.workspace)).toBeNull();
        expect(screen.queryByText(data.people[0].name)).toBeNull();
        expect(onAction).not.toHaveBeenCalled();
        if (state === "error") {
          fireEvent.click(screen.getByRole("button", { name: "Try again" }));
          expect(onAction).toHaveBeenCalledWith(`Retry ${surface}`);
        }
      });
    }
    it("renders its ready recipe from explicit data without triggering a mutation", () => {
      const onAction = vi.fn();
      render(<TeamSurfaceExample surface={surface} data={data} state="ready" canAct={false} onAction={onAction} />);
      openSurface(surface);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(onAction).not.toHaveBeenCalled();
    });
  });
}

it("does not guess a free plan from absent billing data", () => {
  render(<TeamSurfaceExample surface="billing" data={{ ...data, plan: "" }} state="ready" canAct onAction={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("This does not mean it is on a free plan");
  expect(screen.queryByRole("button", { name: "Open billing" })).toBeNull();
});

it("removes an open profile's identity and actions when access is revoked", () => {
  const props = { surface: "profile" as const, data, canAct: true, onAction: vi.fn() };
  const view = render(<TeamSurfaceExample {...props} state="ready" />);
  openSurface("profile");
  expect(screen.getByText(data.people[0].name)).toBeTruthy();
  view.rerender(<TeamSurfaceExample {...props} state="no-access" />);
  expect(screen.queryByText(data.people[0].name)).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy name" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("You cannot view this profile");
});

it("keeps Share choices through offline/error, confirms discard and clears them on revocation", () => {
  const props = { surface: "share" as const, data, canAct: true, onAction: vi.fn() };
  const view = render(<TeamSurfaceExample {...props} state="ready" />);
  openSurface("share");
  fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "driver" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Can approve/ }));
  view.rerender(<TeamSurfaceExample {...props} state="offline" />);
  expect(screen.getByRole("status").textContent).toContain("Your unsaved choices stay");
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("driver");
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).disabled).toBe(true);
  view.rerender(<TeamSurfaceExample {...props} state="error" />);
  view.rerender(<TeamSurfaceExample {...props} state="ready" />);
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("driver");
  expect((screen.getByRole("checkbox", { name: /Can approve/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.getByRole("dialog", { name: "Discard access choices?" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("driver");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard choices" }));
  openSurface("share");
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("viewer");
  fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "driver" } });
  view.rerender(<TeamSurfaceExample {...props} state="no-access" />);
  expect(screen.queryByRole("combobox")).toBeNull();
  view.rerender(<TeamSurfaceExample {...props} state="ready" />);
  expect(screen.queryByRole("combobox", { name: "Access level" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Person to share with" }), { target: { value: data.people[0].id } });
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("viewer");
});

it("clears an open Share draft when its scope changes", () => {
  const props = { surface: "share" as const, data, state: "ready" as const, canAct: true, onAction: vi.fn() };
  const view = render(<TeamSurfaceExample {...props} />);
  openSurface("share");
  fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "driver" } });
  view.rerender(<TeamSurfaceExample {...props} data={{ ...data, organization: "Changed scope" }} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  openSurface("share");
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("viewer");
});

it("offers a working keyboard exit from the desktop viewport for either input authority", () => {
  const view = render(<TeamSurfaceExample surface="desktop" data={data} state="ready" canAct={false} onAction={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Focus desktop viewport" }));
  const viewport = screen.getByRole("region", { name: "Cloud desktop viewport" });
  expect(document.activeElement).toBe(viewport);
  fireEvent.keyDown(viewport, { key: "Escape" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Leave desktop controls" }));
  view.rerender(<TeamSurfaceExample surface="desktop" data={data} state="no-access" canAct={false} onAction={vi.fn()} />);
  expect(screen.queryByRole("region", { name: "Cloud desktop viewport" })).toBeNull();
});

it("renders returned billing, profile and automation details without fabricated defaults", () => {
  const detailed: TeamPreviewData = { ...data, profile: { email: "review@example.invalid", role: "Returned role", joined: "Returned join date" }, billing: { seats: "Returned seat count", payer: "Returned payer", nextCharge: "Returned charge" }, schedule: { trigger: "Returned trigger", runs: "Returned runs", lastRun: "Returned last run", nextRun: "Returned next run", created: "Returned creation date" } };
  const props = { data: detailed, state: "ready" as const, canAct: false, onAction: vi.fn() };
  const view = render(<TeamSurfaceExample surface="billing" {...props} />);
  for (const value of Object.values(detailed.billing!)) expect(screen.getByText(value)).toBeTruthy();
  view.rerender(<TeamSurfaceExample surface="automations" {...props} />);
  for (const value of Object.values(detailed.schedule!)) expect(screen.getByText(value)).toBeTruthy();
  view.rerender(<TeamSurfaceExample surface="profile" {...props} />);
  openSurface("profile");
  for (const value of Object.values(detailed.profile!)) expect(screen.getByText(value)).toBeTruthy();
});

it("shows distinct workspace/local ports and prevents using a closed forward", () => {
  const onAction = vi.fn();
  const props = { surface: "ports" as const, data, state: "ready" as const, canAct: true, onAction };
  const view = render(<TeamSurfaceExample {...props} />);
  openSurface("ports");
  expect(screen.getByText("3000")).toBeTruthy();
  expect(screen.getByText("127.0.0.1:5173")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  expect(onAction).toHaveBeenCalledWith("Open preview");
  view.rerender(<TeamSurfaceExample {...props} data={{ ...data, forwardState: "closed" }} />);
  expect(screen.queryByText("127.0.0.1:5173")).toBeNull();
  expect(screen.getByText("Forward ended")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
  expect(onAction).toHaveBeenCalledOnce();
});

it("keeps the automation filter reachable when it hides rows", () => {
  render(<TeamSurfaceExample surface="automations" data={data} state="ready" canAct onAction={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "Organization" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Automations filter" }), { target: { value: "hide" } });
  expect(screen.queryByText(data.automation)).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Automations are hidden");
  fireEvent.change(screen.getByRole("combobox", { name: "Automations filter" }), { target: { value: "only" } });
  expect(screen.getByText(data.automation)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Automation actions" })).toBeTruthy();
});

it("switches the local workspace tab shell without connecting a desktop", () => {
  const onAction = vi.fn();
  render(<TeamSurfaceExample surface="desktop" data={data} state="ready" canAct onAction={onAction} />);
  expect(screen.getByRole("tablist", { name: "Workspace preview tabs" })).toBeTruthy();
  const conversation = screen.getByRole("tab", { name: "Conversation" });
  conversation.focus();
  fireEvent.keyDown(conversation, { key: "Enter" });
  expect(conversation.getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByRole("region", { name: "Cloud desktop viewport" })).toBeNull();
  const desktop = screen.getByRole("tab", { name: "Desktop" });
  desktop.focus();
  fireEvent.keyDown(desktop, { key: " " });
  expect(screen.getByRole("region", { name: "Cloud desktop viewport" })).toBeTruthy();
  expect(onAction).not.toHaveBeenCalled();
});

it("renders all empty recipes without data", () => {
  const empty: TeamPreviewData = { people: [], workspace: "", organization: "", plan: "", automation: "", port: null };
  for (const surface of surfaceIds) {
    const view = render(<TeamSurfaceExample surface={surface} data={empty} state="empty" canAct={false} onAction={vi.fn()} />);
    openSurface(surface);
    expect(screen.getByRole("status").textContent).toContain(surfaceMessage(surface, "empty").title);
    view.unmount();
  }
});

it("opens automation actions with the keyboard and returns focus on Escape", async () => {
  const onAction = vi.fn();
  render(<TeamSurfaceExample surface="automations" data={data} state="ready" canAct onAction={onAction} />);
  const trigger = screen.getByRole("button", { name: "Automation actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "Duplicate" })).toBeTruthy());
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(onAction).not.toHaveBeenCalled();
});

it("keeps Share bound to its recipient across reorder and clears permissions when that person disappears", () => {
  const second = { id: "second-member", name: "Second review member", presence: "unknown" as const };
  const props = { surface: "share" as const, data: { ...data, people: [...data.people, second] }, state: "ready" as const, canAct: true, onAction: vi.fn() };
  const view = render(<TeamSurfaceExample {...props} />);
  openSurface("share");
  fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "driver" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Can approve/ }));
  view.rerender(<TeamSurfaceExample {...props} data={{ ...data, people: [second, ...data.people] }} />);
  expect((screen.getByRole("combobox", { name: "Person to share with" }) as HTMLSelectElement).value).toBe(data.people[0].id);
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("driver");
  fireEvent.click(screen.getByRole("button", { name: "Review access changes" }));
  view.rerender(<TeamSurfaceExample {...props} data={{ ...data, people: [second] }} />);
  expect(screen.queryByRole("combobox", { name: "Access level" })).toBeNull();
  expect(screen.queryByText(/Review member: Can send/)).toBeNull();
  expect((screen.getByRole("combobox", { name: "Person to share with" }) as HTMLSelectElement).value).toBe("");
  fireEvent.change(screen.getByRole("combobox", { name: "Person to share with" }), { target: { value: second.id } });
  expect((screen.getByRole("combobox", { name: "Access level" }) as HTMLSelectElement).value).toBe("viewer");
  expect((screen.getByRole("checkbox", { name: /Can approve/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "driver" } });
  view.rerender(<TeamSurfaceExample {...props} state="loading" data={{ ...data, people: [] }} />);
  view.rerender(<TeamSurfaceExample {...props} data={data} />);
  expect(screen.queryByRole("combobox", { name: "Access level" })).toBeNull();
  expect((screen.getByRole("combobox", { name: "Person to share with" }) as HTMLSelectElement).value).toBe("");
});
