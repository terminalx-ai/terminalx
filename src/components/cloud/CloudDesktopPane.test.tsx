import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { VncState } from "@/components/computer/VncView";
import { CloudDesktopPane } from "./CloudDesktopPane";

const fixture = vi.hoisted(() => ({
  fail: null as ((error: unknown) => void) | null,
}));

vi.mock("@/lib/cloudDesktopChannel", () => ({
  CloudDesktopChannel: class {
    constructor(_client: unknown, _control: boolean, fail: (error: unknown) => void) { fixture.fail = fail; }
  },
}));

vi.mock("@/components/computer/VncView", () => ({
  VncView: ({ attempt, control, onState, openChannel }: {
    attempt: number; control: boolean; onState: (state: VncState) => void; openChannel: () => unknown;
  }) => <div data-testid="fixture-vnc" data-attempt={attempt} data-control={control}>
    <button type="button" onClick={() => { openChannel(); onState("connected"); }}>Connected</button>
    <button type="button" onClick={() => onState("disconnected")}>Drop widget</button>
  </div>,
}));

afterEach(() => { cleanup(); fixture.fail = null; });

const client = {
  connection: { state: "connected" },
  hasCapability: () => true,
} as unknown as CloudSessionModel["client"];

it("shows connecting, watch-only and disconnected states, and allows an explicit retry", () => {
  const reconnect = vi.fn();
  render(<CloudDesktopPane client={client} asleep={false} control={false} onReconnect={reconnect} />);
  expect(screen.getByRole("status").textContent).toBe("Connecting…");
  expect(screen.getByText("You need edit access to use the cloud desktop")).toBeTruthy();
  expect(screen.getByTestId("fixture-vnc").getAttribute("data-control")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Drop widget" }));
  expect(screen.getByRole("status").textContent).toBe("Disconnected");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(screen.getByRole("status").textContent).toBe("Connecting…");
  expect(screen.getByTestId("fixture-vnc").getAttribute("data-attempt")).toBe("1");
  expect(reconnect).not.toHaveBeenCalled();
});

it("uses the runtime's typed image-unavailable result", () => {
  render(<CloudDesktopPane client={client} asleep={false} control onReconnect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  act(() => fixture.fail?.({ code: "cloud_desktop_image_unavailable" }));
  expect(screen.getByRole("status").textContent).toBe("Not available in this workspace image.");
  expect(screen.queryByTestId("fixture-vnc")).toBeNull();
});

it("explains a Chrome startup failure and offers to reconnect", () => {
  render(<CloudDesktopPane client={client} asleep={false} control onReconnect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  act(() => fixture.fail?.({ code: "cloud_desktop_chrome_start_failed" }));
  expect(screen.getByRole("status").textContent).toBe("Chrome could not start in this workspace image.");
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  expect(screen.getByRole("status").textContent).toBe("Connecting…");
});

it("shows a stopped workspace without opening VNC or offering to wake it", () => {
  const reconnect = vi.fn();
  render(<CloudDesktopPane client={client} asleep control onReconnect={reconnect} />);
  expect(screen.getByRole("status").textContent).toBe("The workspace is stopped.");
  expect(screen.queryByTestId("fixture-vnc")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  expect(reconnect).not.toHaveBeenCalled();
});
