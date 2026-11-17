import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {}, gh: {}, git: {}, errorMessage: (error: unknown) => String(error) }));

const { runtimeSessionIn } = await import("./gitSource");

describe("the runtime session a session key names in a workspace", () => {
  it("reads a machine session in its own project (PRO-347)", () => {
    expect(runtimeSessionIn("machine:m1:p1", "machine:m1:p1:s1")).toBe("s1");
  });

  it.each([
    ["another project", "machine:m1:p2:s1"],
    ["another machine", "machine:m2:p1:s1"],
    ["the project itself", "machine:m1:p1"],
    ["a cloud session", "cloud:o:w:s1"],
    ["a local session", "5d3f0a8e-4b1c-4f7e-9a2d-1c6b8e0f2a91"],
  ])("never a session of %s", (_name, key) => {
    expect(runtimeSessionIn("machine:m1:p1", key)).toBeNull();
  });

  it("reads a cloud session in its workspace, as before", () => {
    expect(runtimeSessionIn("cloud:o:w", "cloud:o:w:s1")).toBe("s1");
    expect(runtimeSessionIn("cloud:o:w", "cloud:o:w2:s1")).toBeNull();
    expect(runtimeSessionIn("cloud:o:w", "machine:m1:p1:s1")).toBeNull();
  });
});
