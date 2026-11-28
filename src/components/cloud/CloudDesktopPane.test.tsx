import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudSessionModel } from "@/lib/cloudSession";
import type { VncState } from "@/components/computer/VncView";
import { CloudDesktopPane } from "./CloudDesktopPane";

const fixture = vi.hoisted(() => ({
  fail: null as ((error: unknown) => void) | null,
  opens: [] as boolean[],
}));

vi.mock("@/lib/cloudDesktopChannel", () => ({
  CloudDesktopChannel: class {
    constructor(_client: unknown, control: boolean, fail: (error: unknown) => void) {
      fixture.opens.push(control);
      fixture.fail = fail;
    }
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

afterEach(() => { cleanup(); fixture.fail = null; fixture.opens.length = 0; });

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
  expect(screen.getByRole("status").textContent).toBe("Workspace stopped");
  expect(screen.queryByTestId("fixture-vnc")).toBeNull();
  expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  expect(reconnect).not.toHaveBeenCalled();
});


it("falls back to watch when the runtime refuses control", () => {
  render(<CloudDesktopPane client={client} asleep={false} control onReconnect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  act(() => fixture.fail?.({ code: "forbidden" }));
  expect(screen.getByTestId("fixture-vnc").getAttribute("data-control")).toBe("false");
  expect(screen.getByRole("status").textContent).toBe("Connecting…");
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  expect(fixture.opens).toEqual([true, false]);
  act(() => fixture.fail?.({ code: "forbidden" }));
  expect(screen.getByRole("status").textContent).toBe("Cloud desktop access is unavailable.");
});

// PRO-209: an agent driving the desktop's browser.
const driving = { agent: "Claude Code", tabTitle: "Push org events", action: "Clicking “Sign in”", actions: 6, held: false };

it("shows who drives and what it does, sends none of your input meanwhile, and takes control", async () => {
  const call = vi.fn().mockResolvedValue({});
  const controlled = { ...client, call } as unknown as CloudSessionModel["client"];
  const view = render(<CloudDesktopPane client={controlled} asleep={false} control agent={driving} onReconnect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Connected" }));
  expect(screen.getByTestId("cloud-desktop-agent").textContent).toContain("Claude Code is driving · tab Push org events");
  expect(screen.getByText(/Your clicks and keys are not sent while Claude Code drives\./)).toBeTruthy();
  expect(screen.getByTestId("cloud-desktop-agent-action").textContent).toBe("Clicking “Sign in” · action 6");
  expect(screen.getByTestId("fixture-vnc").getAttribute("data-control")).toBe("false");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Take control" })); });
  expect(call).toHaveBeenCalledWith("desktop.takeControl", {});

  view.rerender(<CloudDesktopPane client={controlled} asleep={false} control agent={{ ...driving, held: true }} onReconnect={vi.fn()} />);
  expect(screen.getByTestId("cloud-desktop-agent").textContent).toContain("You have control · Claude Code waits");
  expect(screen.queryByTestId("cloud-desktop-agent-action")).toBeNull();
  expect(screen.getByTestId("fixture-vnc").getAttribute("data-control")).toBe("true");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hand back" })); });
  expect(call).toHaveBeenLastCalledWith("desktop.handBack", {});
});

it("offers a watcher no control over the agent", () => {
  render(<CloudDesktopPane client={client} asleep={false} control={false} agent={driving} onReconnect={vi.fn()} />);
  expect(screen.getByTestId("cloud-desktop-agent").textContent).toContain("Claude Code is driving");
  expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
});
