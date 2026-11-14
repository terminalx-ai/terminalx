import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { AgentIdleSettings, idleLimitLabel } = await import("./AgentIdleSettings");

let saved = 60;
let refuse: string | null = null;

beforeEach(() => {
  saved = 60;
  refuse = null;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "agent_settings":
        return { idleStopMinutes: saved };
      case "set_agent_idle_stop_minutes":
        if (refuse) throw refuse;
        saved = args.minutes as number;
        return { idleStopMinutes: saved };
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(cleanup);

const choice = (name: string) => screen.getByRole("radio", { name });

describe("idle agent settings", () => {
  it("shows the limit the runtime reads, and saves another one", async () => {
    render(<AgentIdleSettings />);
    await waitFor(() => expect(choice("1 hour").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Never", "30 min", "1 hour", "2 hours", "4 hours", "8 hours", "1 day"]);

    fireEvent.click(choice("4 hours"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_agent_idle_stop_minutes", { minutes: 240 }));
    await waitFor(() => expect(choice("4 hours").getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(choice("Never"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_agent_idle_stop_minutes", { minutes: 0 }));
    expect(saved).toBe(0);
  });

  it("goes back to what was saved when the change is refused, and says why", async () => {
    render(<AgentIdleSettings />);
    await waitFor(() => expect(choice("1 hour").getAttribute("aria-checked")).toBe("true"));
    refuse = "The settings file could not be written.";
    fireEvent.click(choice("30 min"));
    expect((await screen.findByRole("alert")).textContent).toBe("The settings file could not be written.");
    expect(choice("1 hour").getAttribute("aria-checked")).toBe("true");
    expect(saved).toBe(60);
  });

  it("names each limit as the row reads it", () => {
    expect([0, 30, 60, 120, 1440].map(idleLimitLabel)).toEqual(["Never", "30 min", "1 hour", "2 hours", "1 day"]);
  });
});
