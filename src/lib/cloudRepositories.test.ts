import { describe, expect, it } from "vitest";
import { clonePaths, parseGithubRepository } from "./cloudRepositories";

describe("cloud repository input", () => {
  it.each(["https://secret@github.com/acme/api", "https://github.com/acme/..", "https://github.com/acme/api?token=synthetic", "https://github.com/acme/api#main", "http://github.com/acme/api", "https://github.com.evil.test/acme/api", "file:///tmp/repo"]) ("refuses %s", (url) => expect(parseGithubRepository(url)).toBeNull());
  it("normalizes without changing repository case and predicts colliding directory names", () => {
    expect(parseGithubRepository(" https://github.com/Acme/api.git ")).toEqual({ fullName: "Acme/api", cloneUrl: "https://github.com/Acme/api.git" });
    expect(clonePaths([{ fullName: "a/api" }, { fullName: "b/api" }, { fullName: "c/api-2" }])).toEqual(["/var/lib/terminalx/workspace/api", "/var/lib/terminalx/workspace/api-2", "/var/lib/terminalx/workspace/api-2-2"]);
  });
});
