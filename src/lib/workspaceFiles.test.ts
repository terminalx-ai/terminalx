import { describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";

const localFs = vi.hoisted(() => ({ writeText: vi.fn(async () => 2), createText: vi.fn(async () => 1) }));
vi.mock("@/lib/api", () => ({ fs: localFs, api: {} }));

const { cloudFileSource, localFileSource } = await import("./workspaceFiles");

describe("localFileSource.writeText", () => {
  it("creates exclusively when the base says the file must not exist, and overwrites otherwise", async () => {
    const source = localFileSource("/repos/alpha");
    expect(await source.writeText("docs/new.md", "", null)).toEqual({ version: "1" });
    expect(localFs.createText).toHaveBeenCalledWith("/repos/alpha/docs/new.md", "");
    expect(localFs.writeText).not.toHaveBeenCalled();
    expect(await source.writeText("docs/new.md", "text", undefined)).toEqual({ version: "2" });
    expect(localFs.writeText).toHaveBeenCalledWith("/repos/alpha/docs/new.md", "text");
  });
});

const connected: WorkspaceConnectionState = {
  state: "connected",
  runtimeGeneration: 1,
  runtimeEpoch: "e1",
  runtimeVersion: "0.3.0",
  capabilities: ["fs/1", "git/1"],
  authority: "manage",
};

/** A runtime answering `git.*` from `answer`; a thrown `{ code }` is a refusal. */
function client(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const messages = new Set<(message: unknown) => void>();
  const states = new Set<(state: WorkspaceConnectionState) => void>();
  const transport: WorkspaceTransport = {
    send(frame) {
      queueMicrotask(() => {
        try {
          const result = answer(frame.method, (frame.params ?? {}) as Record<string, unknown>);
          for (const listener of messages) listener({ id: frame.id, ok: true, result });
        } catch (error) {
          for (const listener of messages) listener({ id: frame.id, ok: false, error: { code: (error as { code: string }).code, message: "refused" } });
        }
      });
      return true;
    },
    onMessage: (listener) => (messages.add(listener), () => messages.delete(listener)),
    onState: (listener) => (states.add(listener), () => states.delete(listener)),
    close() {},
  };
  const rpc = new WorkspaceRpcClient(transport);
  for (const listener of states) listener(connected);
  return rpc;
}

const file = (path: string) => ({ path, index: " ", worktree: "M" });

describe("Git badges of a cloud workspace's file tree", () => {
  it("puts a lone clone's paths under its directory", async () => {
    const source = cloudFileSource("cloud:o:w", client(() => ({ repository: true, repo: "app", files: [file("src/main.ts")] })), false);
    expect(await source.changes!()).toEqual([{ path: "app/src/main.ts", status: "modified" }]);
  });

  it("reads each of several repositories under its own directory", async () => {
    const source = cloudFileSource(
      "cloud:o:w",
      client((method, params) => {
        if (method === "git.repositories") return { repositories: [{ repo: "app" }, { repo: "libs/core" }] };
        if (!params.repo) throw { code: "ambiguous_repository" };
        return { repository: true, repo: params.repo, files: [file("a.ts")] };
      }),
      false,
    );
    expect(await source.changes!()).toEqual([
      { path: "app/a.ts", status: "modified" },
      { path: "libs/core/a.ts", status: "modified" },
    ]);
  });
});

describe("a machine session's files, rooted at its worktree (PRO-347)", () => {
  it.each([
    ["src", ".", "src", ["."]],
    ["trees/topic/src", "trees/topic", "src", [".", "trees", "trees/topic", "trees/topic/src-sibling"]],
    ["/outside/topic/src", "/outside/topic", "src", [".", "/outside/topic"]],
  ] as const)("scopes change badges for %s to its containing repository", async (base, repo, prefix, repositories) => {
    const source = cloudFileSource(
      `machine:m:p/${base}`,
      client((method, params) => {
        if (method === "git.repositories") return { repositories: repositories.map((name) => ({ repo: name })) };
        expect(method).toBe("git.status");
        expect(params).toEqual({ repo });
        return { repository: true, repo, files: [file(`${prefix}/nested/main.ts`), file(`${prefix}-sibling/other.ts`), file("outside.ts")] };
      }),
      false,
      base,
    );
    expect(await source.changes!()).toEqual([{ path: "nested/main.ts", status: "modified" }]);
  });

  it("includes nested worktrees' badges when Files is rooted at their parent folder", async () => {
    const root = ".raccoon/worktrees";
    const requested: unknown[] = [];
    const source = cloudFileSource(
      `machine:m:p/${root}`,
      client((method, params) => {
        if (method === "git.repositories") {
          return { repositories: [".", `${root}/topic`, `${root}/removed`, `${root}-other/topic`].map((repo) => ({ repo })) };
        }
        requested.push(params.repo);
        if (params.repo === `${root}/removed`) throw { code: "not_found" };
        return {
          repository: true,
          files: params.repo === "." ? [file(`${root}/notes.txt`), file("README.md")] : [file("src/main.ts")],
        };
      }),
      false,
      root,
    );
    expect(await source.changes!()).toEqual([
      { path: "notes.txt", status: "modified" },
      { path: "topic/src/main.ts", status: "modified" },
    ]);
    expect(requested).toEqual([".", `${root}/topic`, `${root}/removed`]);
  });

  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const source = () =>
    cloudFileSource(
      "machine:m:p/wt/read",
      client((method, params) => {
        asked.push({ method, params });
        if (method === "fs.list") return { path: params.path, entries: [{ name: "src", path: `${params.path}/src`, kind: "directory" }, { name: "x", path: "elsewhere/x", kind: "file" }] };
        if (method === "git.repositories") return { repositories: [{ repo: "." }, { repo: "wt/read" }] };
        if (method === "git.status") return { repository: true, repo: params.repo, files: [file("src/a.ts")] };
        throw { code: "method_not_found" };
      }),
      false,
      "wt/read",
    );

  it("asks the runtime for paths under the worktree and gives back paths relative to it", async () => {
    asked.length = 0;
    const files = source();
    const top = await files.listDir("");
    const below = await files.listDir("src");
    expect(asked.filter((call) => call.method === "fs.list").map((call) => call.params.path)).toEqual(["wt/read", "wt/read/src"]);
    expect(top.find((entry) => entry.name === "src")?.path).toBe("src");
    expect(below.find((entry) => entry.name === "src")?.path).toBe("src/src");
    // One the runtime named outside the worktree is listed by its name only, never by the runtime's path.
    expect(top.find((entry) => entry.name === "x")?.path).toBe("x");
    files.dispose();
  });

  it("reads Git badges from the worktree's own repository, with its paths as they are", async () => {
    asked.length = 0;
    const files = source();
    expect(await files.changes!()).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(asked.filter((call) => call.method === "git.status").map((call) => call.params.repo)).toEqual(["wt/read"]);
    files.dispose();
  });
});

describe("a machine session's files in a worktree outside its project (PRO-405)", () => {
  const worktree = "/Users/me/worktrees/read";
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const source = (base = worktree) =>
    cloudFileSource(
      `machine:m:p/${base}`,
      client((method, params) => {
        asked.push({ method, params });
        // The runtime names paths in an outside worktree absolutely, as it lists the worktree.
        if (method === "fs.list") return { path: params.path, entries: [{ name: "src", path: `${params.path}/src`, kind: "directory" }, { name: "x", path: "elsewhere/x", kind: "file" }] };
        if (method === "fs.read") return { path: params.path, size: 2, version: "v1", offset: 0, eof: true, etag: "e1", text: "hi" };
        if (method === "fs.search") return { searchId: params.searchId, hits: [{ path: `${worktree}/src/a.ts`, line: 1, col: 0, text: "hi", matches: [[0, 2]] }, { path: "README.md", line: 1, col: 0, text: "hi", matches: [[0, 2]] }], files: 2, capped: false, cancelled: false };
        if (method === "git.repositories") return { repositories: [{ repo: "." }, { repo: worktree }] };
        if (method === "git.status") return { repository: true, repo: params.repo, files: [file("src/a.ts")] };
        throw { code: "method_not_found" };
      }),
      false,
      base,
    );

  it("asks for the worktree's absolute paths and gives back paths relative to it", async () => {
    asked.length = 0;
    const files = source();
    const top = await files.listDir("");
    await files.listDir("src");
    expect(asked.filter((call) => call.method === "fs.list").map((call) => call.params.path)).toEqual([worktree, `${worktree}/src`]);
    expect(top.map((entry) => entry.path)).toEqual(["src", "x"]);
    expect((await files.readText("src/a.ts")).content).toBe("hi");
    expect(asked.find((call) => call.method === "fs.read")?.params.path).toBe(`${worktree}/src/a.ts`);
    // Nothing relative to the worktree may climb out of it.
    await expect(files.readText("../other/a.ts")).rejects.toThrow();
    files.dispose();
  });

  it("searches the worktree only and reads its Git badges from its own repository", async () => {
    asked.length = 0;
    const files = source();
    const found = await files.search!({ query: "hi", regex: false, caseSensitive: false, wholeWord: false }, new AbortController().signal);
    expect(asked.find((call) => call.method === "fs.search")?.params.path).toBe(worktree);
    expect(found.hits.map((hit) => hit.path)).toEqual(["src/a.ts"]);
    expect(await files.changes!()).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(asked.filter((call) => call.method === "git.status").map((call) => call.params.repo)).toEqual([worktree]);
    files.dispose();
  });

  it("preserves literal backslashes in the absolute checkout and its file names", async () => {
    asked.length = 0;
    const base = "/Users/me/worktrees/team\\read";
    const files = source(base);
    await files.listDir("");
    await files.readText("src/file\\name.ts");
    expect(asked.find((call) => call.method === "fs.list")?.params.path).toBe(base);
    expect(asked.find((call) => call.method === "fs.read")?.params.path).toBe(`${base}/src/file\\name.ts`);
    files.dispose();
  });
});
