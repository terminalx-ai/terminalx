import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EnvironmentLeaveGuard } from "./EnvironmentLeaveGuard";
import { navigateFromEnvironment } from "@/lib/environmentLeaveGuard";

afterEach(cleanup);
function Page({ unbuilt = true, unsaved = true }: { unbuilt?: boolean; unsaved?: boolean }) {
  return <EnvironmentLeaveGuard unbuilt={unbuilt} unsaved={unsaved} />;
}
it("keeps edits and the current page on Cancel, then resumes the exact destination on Leave", () => {
  render(<><Page /><button onClick={() => navigateFromEnvironment(destination)}>Navigate</button></>);
  const destination = vi.fn(); fireEvent.click(screen.getByText("Navigate"));
  expect(screen.getByRole("heading", { name: "Leave without building?" })).toBeTruthy(); expect(destination).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Keep editing")); expect(destination).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Navigate")); fireEvent.click(screen.getByRole("button", { name: "Leave without building" }));
  expect(destination).toHaveBeenCalledOnce();
});
it("guards saved but unbuilt changes and browser close, and releases the guard after building", () => {
  const view = render(<Page unsaved={false} />); const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  view.rerender(<Page unbuilt={false} />); const next = vi.fn(); navigateFromEnvironment(next); expect(next).toHaveBeenCalledOnce();
});
it("unregisters when the environment unmounts", () => {
  const view = render(<Page />); view.unmount(); const next = vi.fn(); navigateFromEnvironment(next); expect(next).toHaveBeenCalledOnce();
});
