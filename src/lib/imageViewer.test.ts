import { afterEach, describe, expect, it } from "vitest";
import { closeImageViewer, openImageViewer, stepImageViewer } from "./imageViewer";
import { renderHook, act } from "@testing-library/react";
import { useImageViewer } from "./imageViewer";

const images = ["a", "b", "c"].map((name) => ({ src: `data:image/png;base64,${name}`, name }));

afterEach(() => closeImageViewer());

describe("image viewer", () => {
  it("opens on the image asked for, kept within the set, and steps through it with wrap-around", () => {
    const { result } = renderHook(() => useImageViewer());
    expect(result.current).toBeNull();
    act(() => openImageViewer(images, 9));
    expect(result.current?.index).toBe(2);
    act(() => stepImageViewer(1));
    expect(result.current?.index).toBe(0);
    act(() => stepImageViewer(-1));
    expect(result.current?.index).toBe(2);
    act(() => closeImageViewer());
    expect(result.current).toBeNull();
  });

  it("does not open on nothing", () => {
    const { result } = renderHook(() => useImageViewer());
    act(() => openImageViewer([]));
    expect(result.current).toBeNull();
  });
});
