import { describe, expect, it } from "vitest";
import { expandPreviewUrl, moveRepositoryEntry, validateAction, validatePreviewUrl, visibleActions, type RepositoryAction } from "./repositoryActions";

const dev: RepositoryAction = { id: "dev", name: "Dev", icon: "play", command: "pnpm dev", hidden: false, concurrent: false, runAfterSetup: false };
const test = { ...dev, id: "test", name: "Test", command: "pnpm test" };

describe("repository action validation and ordering", () => {
  it("requires a name and nonblank command", () => {
    expect(validateAction({ ...dev, name: " \n", command: "\t\n" }, [])).toEqual({ name: "Enter a name.", command: "Enter a command." });
  });

  it("checks hidden names too, ignoring surrounding spaces, case and compatibility characters", () => {
    for (const name of ["Dev", " dev ", "Ｄｅｖ"]) {
      expect(validateAction({ ...test, name }, [{ ...dev, hidden: true }]).name).toBe("Choose a unique name.");
    }
    expect(validateAction(dev, [dev, test]).name).toBeUndefined();
  });

  it("moves items without mutating the input and keeps the default as the first visible item", () => {
    const actions = [dev, { ...test, hidden: true }, { ...dev, id: "lint", name: "Lint" }];
    const reordered = moveRepositoryEntry(actions, "lint", -1);
    expect(reordered.map((entry) => entry.id)).toEqual(["dev", "lint", "test"]);
    expect(actions.map((entry) => entry.id)).toEqual(["dev", "test", "lint"]);
    expect(visibleActions(moveRepositoryEntry(reordered, "dev", 1)).map((entry) => entry.id)).toEqual(["lint", "dev"]);
    expect(visibleActions(actions.map((entry) => ({ ...entry, hidden: true })))).toEqual([]);
  });

  it("leaves missing entries and boundary moves alone", () => {
    const actions = [dev, test];
    expect(moveRepositoryEntry(actions, "missing", 1)).toEqual(actions);
    expect(moveRepositoryEntry(actions, "dev", -1)).toEqual(actions);
    expect(moveRepositoryEntry(actions, "test", 1)).toEqual(actions);
    expect(moveRepositoryEntry([], "dev", 1)).toEqual([]);
  });
});

describe("preview URL templates", () => {
  it("expands the active session's first and numbered ports everywhere in a URL", () => {
    const ports = Array.from({ length: 10 }, (_, index) => 4010 + index);
    expect(expandPreviewUrl("http://localhost:$PORT", ports)).toEqual({ url: "http://localhost:4010/" });
    expect(expandPreviewUrl("http://localhost:$PORT_1/?api=$PORT_2&last=$PORT_10&again=$PORT", ports)).toEqual({ url: "http://localhost:4010/?api=4011&last=4019&again=4010" });
    expect(expandPreviewUrl("http://localhost:$PORT", [5010])).toEqual({ url: "http://localhost:5010/" });
  });

  it("supports literal URLs, IPv6, paths, queries and fragments without any port allocation", () => {
    expect(expandPreviewUrl(" https://example.com/docs?q=a%20b#intro ", [])).toEqual({ url: "https://example.com/docs?q=a%20b#intro" });
    expect(expandPreviewUrl("http://[::1]:$PORT/app?price=%24", [3000])).toEqual({ url: "http://[::1]:3000/app?price=%24" });
  });

  it.each([[], [0], [-1], [65536], [1.5], [NaN], [Infinity]])("never guesses an absent or invalid port: %j", (...ports) => {
    expect(expandPreviewUrl("http://localhost:$PORT", ports)).toMatchObject({ error: expect.stringContaining("No allocated port") });
  });

  it("requires every referenced port", () => {
    expect(expandPreviewUrl("http://localhost:$PORT")).toMatchObject({ error: expect.stringContaining("No allocated port") });
    expect(expandPreviewUrl("http://localhost:$PORT_2", [3000])).toMatchObject({ error: expect.stringContaining("$PORT_2") });
  });

  it.each(["$PORT_0", "$PORT_01", "$PORT_", "$PORT_no", "$PORT_2foo", "$PORTfoo", "${PORT}", "$PORT_999999999999999999999999", "$OTHER"]) ("rejects unsupported placeholder %s", (variable) => {
    expect(expandPreviewUrl(`http://localhost:3000/${variable}`, [3000])).toHaveProperty("error");
  });

  it.each(["", "javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "//localhost:3000", "http:localhost", "http:///localhost", "http://user:secret@localhost:3000", "http://localhost:99999", "http://local\nhost:3000", "http://localhost/a b", "http://localhost\\evil", "not a URL"]) ("rejects unsafe or malformed URL %j", (url) => {
    expect(expandPreviewUrl(url, [3000])).toHaveProperty("error");
  });

  it("validates saved templates without allocating ports and checks unique preview names", () => {
    const entry = { id: "web", name: "Web", url: "http://localhost:$PORT_10" };
    expect(validatePreviewUrl(entry, [entry])).toEqual({ name: undefined, url: undefined });
    expect(validatePreviewUrl({ ...entry, id: "other", name: " web " }, [entry]).name).toBe("Choose a unique name.");
    expect(validatePreviewUrl({ ...entry, name: "", url: "" }, []).name).toBe("Enter a name.");
    expect(validatePreviewUrl({ ...entry, url: "" }, []).url).toBe("Enter a URL.");
  });
});
