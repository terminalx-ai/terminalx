import { afterEach, expect, it, vi } from "vitest";

const { addProject, startSessionIn } = vi.hoisted(() => ({ addProject: vi.fn(), startSessionIn: vi.fn() }));
vi.mock("@/lib/sessions", () => ({ addProject, startSessionIn }));
vi.mock("@/lib/prefs", () => ({ setPrefs: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { attachProject } = await import("./projectStart");
const { useProjectAdded, dismissProjectAdded } = await import("./projectAdded");
const { renderHook, act } = await import("@testing-library/react");

afterEach(() => { act(() => dismissProjectAdded()); });

it("announces the project that every start action attaches, with its path", async () => {
  addProject.mockResolvedValue({ path: "/repos/server", name: "server" });
  const { result } = renderHook(() => useProjectAdded());
  expect(result.current).toBeNull();
  await act(async () => { await attachProject("/repos/server"); });
  expect(result.current).toMatchObject({ path: "/repos/server", name: "server" });
  expect(startSessionIn).toHaveBeenCalledWith("/repos/server", null);
});
