import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useResourceSampling } from "./statusPolling";

function Probe({ open, sample }: { open: boolean; sample: () => void }) {
  useResourceSampling(open, sample);
  return null;
}

describe("resource sampling guard", () => {
  afterEach(() => vi.useRealTimers());

  it("never invokes the ps-backed sample while the popover is closed", async () => {
    vi.useFakeTimers();
    const sample = vi.fn();
    const view = render(<Probe open={false} sample={sample} />);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(sample).not.toHaveBeenCalled();

    view.rerender(<Probe open sample={sample} />);
    expect(sample).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(sample).toHaveBeenCalledTimes(3);

    view.rerender(<Probe open={false} sample={sample} />);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(sample).toHaveBeenCalledTimes(3);
  });
});
