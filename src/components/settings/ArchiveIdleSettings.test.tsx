import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { ArchiveIdleSettings, archiveLimitLabel } = await import("./ArchiveIdleSettings");

let saved = 7;
let refuse: string | null = null;

beforeEach(() => {
  saved = 7;
  refuse = null;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "conversation_settings":
        return { archiveIdleDays: saved };
      case "set_archive_idle_days":
        if (refuse) throw refuse;
        saved = args.days as number;
        return { archiveIdleDays: saved };
      case "archive_idle_sessions":
        return [];
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(cleanup);

const choice = (name: string) => screen.getByRole("radio", { name });

describe("archive idle conversations setting", () => {
  it("shows the limit the runtime reads, saves another one and sweeps at once", async () => {
    render(<ArchiveIdleSettings />);
    await waitFor(() => expect(choice("7 days").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Never", "1 day", "3 days", "7 days", "14 days", "30 days"]);

    fireEvent.click(choice("1 day"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_archive_idle_days", { days: 1 }));
    await waitFor(() => expect(choice("1 day").getAttribute("aria-checked")).toBe("true"));
    // A shorter limit applies now, not at the next half-hour sweep.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("archive_idle_sessions", { keep: [] }));

    fireEvent.click(choice("Never"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_archive_idle_days", { days: 0 }));
    expect(saved).toBe(0);
  });

  it("goes back to what was saved when the change is refused, says why, and sweeps nothing", async () => {
    render(<ArchiveIdleSettings />);
    await waitFor(() => expect(choice("7 days").getAttribute("aria-checked")).toBe("true"));
    refuse = "The settings file could not be written.";
    fireEvent.click(choice("3 days"));
    expect((await screen.findByRole("alert")).textContent).toBe("The settings file could not be written.");
    expect(choice("7 days").getAttribute("aria-checked")).toBe("true");
    expect(saved).toBe(7);
    expect(invoke).not.toHaveBeenCalledWith("archive_idle_sessions", expect.anything());
  });

  it("names each limit as the row reads it", () => {
    expect([0, 1, 3, 7, 14, 30].map(archiveLimitLabel)).toEqual(["Never", "1 day", "3 days", "7 days", "14 days", "30 days"]);
  });
});
