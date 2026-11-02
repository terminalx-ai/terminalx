import { afterEach, expect, it, vi } from "vitest";
import { transcriptionPersonalization } from "./transcriptionPersonalization";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
afterEach(() => vi.restoreAllMocks());
it("refreshes context caches only after a successful local save or reset", async () => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  mocks.invoke.mockRejectedValueOnce(new Error("Store unavailable"));
  await expect(transcriptionPersonalization.reset()).rejects.toThrow("Store unavailable");
  expect(dispatch).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValueOnce({ options: {}, entries: [] });
  await transcriptionPersonalization.reset();
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0][0].type).toBe("transcription-personalization-changed");
});
