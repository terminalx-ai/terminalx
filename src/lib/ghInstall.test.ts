import { describe, expect, it } from "vitest";
import { ghInstallCommand } from "./ghInstall";

describe("the GitHub CLI's install command", () => {
  it("is the official one for each system that has one, and none for Linux", () => {
    expect(ghInstallCommand("windows")).toBe("winget install --id GitHub.cli --source winget");
    expect(ghInstallCommand("macos")).toBe("brew install gh");
    expect(ghInstallCommand("linux")).toBeNull();
    expect(ghInstallCommand(null)).toBeNull();
  });
});
