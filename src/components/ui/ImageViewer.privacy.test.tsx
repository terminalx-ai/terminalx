import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshDataPrivacy } from "@/lib/dataPrivacy";
import { closeImageViewer, openImageViewer, stepImageViewer } from "@/lib/imageViewer";
import { ImageViewerHost } from "./ImageViewer";
const native = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<object>()), invoke: native }));
beforeEach(async () => {
  native.mockResolvedValue({ enabled: false, managed: false });
  await refreshDataPrivacy();
});
afterEach(() => { cleanup(); closeImageViewer(); vi.unstubAllGlobals(); });
it.each([false, true])("withdraws full-size external images and copy fetches, keeps local images and restores (managed=%s)", async (managed) => {
  render(<ImageViewerHost />);
  act(() => openImageViewer([{ src: "https://example.test/private.png", name: "remote" }, { src: "data:image/png;base64,AA==", name: "local" }]));
  expect(screen.getByRole("img", { name: "remote" })).toBeTruthy();
  native.mockResolvedValue({ enabled: true, managed });
  await act(() => refreshDataPrivacy());
  expect(screen.queryByRole("img", { name: "remote" })).toBeNull();
  const image = vi.fn();
  vi.stubGlobal("Image", image);
  fireEvent.click(screen.getByRole("button", { name: /copy/i }));
  expect(image).not.toHaveBeenCalled();
  act(() => stepImageViewer(1));
  expect(screen.getByRole("img", { name: "local" })).toBeTruthy();
  native.mockResolvedValue({ enabled: false, managed: false });
  await act(() => refreshDataPrivacy());
  act(() => stepImageViewer(-1));
  expect(screen.getByRole("img", { name: "remote" })).toBeTruthy();
});

it("S-25: blocks external open in default app for SVG images while keeping it for safe raster images", () => {
  render(<ImageViewerHost />);
  act(() => openImageViewer([
    { src: "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E", name: "diagram.svg", path: "/repo/diagram.svg" },
    { src: "http://127.0.0.1:9/shot.png", name: "shot.png", path: "/repo/shot.png" },
  ]));
  expect(screen.queryByRole("button", { name: "Open in default app" })).toBeNull();
  act(() => stepImageViewer(1));
  expect(screen.getByRole("button", { name: "Open in default app" })).toBeTruthy();
});
