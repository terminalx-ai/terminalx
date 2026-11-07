import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ invoke, errorMessage: (error: unknown) => String(error) }));
import { RepositorySetupSettings } from "./RepositorySetupSettings";

beforeEach(() => { invoke.mockReset(); });
afterEach(cleanup);

it("loads the repository command and saves multiline edits and disabling", async () => {
  invoke.mockResolvedValue("bun install");
  render(<RepositorySetupSettings projectPath="/repo" />);
  const field = await screen.findByDisplayValue("bun install");
  expect(invoke).toHaveBeenCalledWith("repository_setup_script", { projectPath: "/repo" });
  fireEvent.change(field, { target: { value: "bun install\ncp ../.env .env" } });
  invoke.mockResolvedValue("bun install\ncp ../.env .env");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save setup script" })));
  expect(invoke).toHaveBeenLastCalledWith("repository_setup_script", { projectPath: "/repo", command: "bun install\ncp ../.env .env" });
  fireEvent.change(field, { target: { value: "" } });
  invoke.mockResolvedValue(null);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save setup script" })));
  expect(invoke).toHaveBeenLastCalledWith("repository_setup_script", { projectPath: "/repo", command: "" });
});

it("does not overwrite a configuration that could not be read", async () => {
  invoke.mockRejectedValue(new Error("Invalid terminalx.json"));
  render(<RepositorySetupSettings projectPath="/repo" />);
  expect((await screen.findByRole("alert")).textContent).toContain("Invalid terminalx.json");
  expect((screen.getByRole("button", { name: "Save setup script" }) as HTMLButtonElement).disabled).toBe(true);
});
