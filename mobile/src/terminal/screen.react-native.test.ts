import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, type Context } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type * as ScreenModule from "./screen";

/*
 * The other terminal tests run in Node, where xterm finds `process.title`, takes its
 * Node branch and never reads `navigator`. On the phone it takes the other branch, and
 * every session screen crashed while those tests passed (#726). These tests load the
 * modules into a separate realm that has only the globals React Native sets up.
 */

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

interface IdleDeadline { didTimeout: boolean; timeRemaining(): number }
/** The longest idle period the HTML spec gives an idle callback, which React Native's native idle callbacks follow. */
const IDLE_PERIOD_MS = 50;

/**
 * A realm with what React Native's InitializeCore defines before any app module runs,
 * and nothing of Node's:
 * - setUpGlobals: `window` and `self` are the global object, and `process` is only
 *   `{ env: { NODE_ENV } }`, with no `title`.
 * - setUpNavigator: `navigator` is `{ product: "ReactNative" }`, unless the runtime made one.
 * - setUpTimers and setUpPerformance (bridgeless): timers, `queueMicrotask`,
 *   `requestIdleCallback` and `performance.now`.
 */
function reactNativeRealm(navigator: Record<string, unknown> = { product: "ReactNative" }) {
  let idleCallbacksRun = 0;
  const context = createContext({
    process: { env: { NODE_ENV: "production" } },
    navigator,
    console,
    performance: { now: () => performance.now() },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestIdleCallback: (callback: (deadline: IdleDeadline) => void) => setTimeout(() => {
      const end = performance.now() + IDLE_PERIOD_MS;
      callback({ didTimeout: false, timeRemaining: () => Math.max(0, end - performance.now()) });
      idleCallbacksRun++;
    }),
    cancelIdleCallback: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  runInContext("globalThis.window = globalThis; globalThis.self = globalThis;", context);
  return { context, idleCallbacksRun: () => idleCallbacksRun };
}

/** Where Metro finds a module: a relative import is a TypeScript file beside its importer; a package resolves through its `main`. */
function resolveFrom(importer: string, specifier: string): string {
  if (specifier.startsWith(".")) return `${resolve(dirname(importer), specifier)}.ts`;
  return createRequire(importer).resolve(specifier);
}

/**
 * Runs a module, and what it imports, in the realm the way Metro bundles them: each
 * module becomes CommonJS, its imports `require` calls in source order, all sharing
 * one global object.
 */
function load(context: Context, entry: string): unknown {
  const modules = new Map<string, { exports: object }>();
  const run = (file: string): unknown => {
    const loaded = modules.get(file);
    if (loaded) return loaded.exports;
    const module = { exports: {} };
    modules.set(file, module);
    const source = readFileSync(file, "utf8");
    const code = file.endsWith(".ts")
      ? ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      : source;
    const factory = runInContext(`(function (exports, require, module) {\n${code}\n})`, context, { filename: file });
    factory.call(module.exports, module.exports, (specifier: string) => run(resolveFrom(file, specifier)), module);
    return module.exports;
  };
  return run(entry);
}

const text = (screen: ScreenModule.TerminalScreen) => screen.lines().map((row) => row.spans.map((span) => span.text).join("").trimEnd());

describe("the phone's terminal screen under React Native's globals", () => {
  it("reproduces the phone: xterm on its own throws there", () => {
    // Without this, the test below could pass because the realm leaked Node's branch.
    expect(() => load(reactNativeRealm().context, require.resolve("@xterm/headless"))).toThrow(/reading 'includes'/);
  });

  it("loads, so a session opens, and draws a tab's terminal as it does in Node", async () => {
    const realm = reactNativeRealm();
    const { TerminalScreen, paletteColor } = load(realm.context, resolve(here, "screen.ts")) as typeof ScreenModule;

    const navigator = runInContext("navigator", realm.context) as Record<string, unknown>;
    expect({ ...navigator }).toEqual({ product: "ReactNative", userAgent: "", platform: "" });

    const screen = new TerminalScreen(20, 3);
    await screen.write("\x1b[1;31merror\x1b[0m: \x1b[38;5;46mok\x1b[0m\r\nnext");
    expect(text(screen)).toEqual(["error: ok", "next", ""]);
    expect(screen.lines()[0].spans).toEqual([
      { text: "error", fg: "#f07178", bold: true },
      { text: ": " },
      { text: "ok", fg: paletteColor(46) },
    ]);

    // A full-screen agent CLI: alternate screen, cursor addressing, bracketed paste.
    await screen.write("\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[2;3Hmiddle\x1b[3;1H> prompt");
    expect(text(screen)).toEqual(["", "  middle", "> prompt"]);
    expect(screen.modes()).toEqual({ bracketedPaste: true, applicationCursorKeys: false });

    // Following the Mac's pane size.
    await screen.write("\x1b[?1049l");
    screen.resize(30, 5);
    await screen.write("\r\nwider than twenty columns");
    expect([screen.cols, screen.rows]).toEqual([30, 5]);
    expect(text(screen)).toEqual(["error: ok", "next", "wider than twenty columns", "", ""]);

    // A narrower pane leaves rows holding more memory than they need, and xterm frees it
    // when idle: outside Node, through `requestIdleCallback`.
    screen.resize(10, 5);
    expect(screen.cols).toBe(10);
    await vi.waitFor(() => expect(realm.idleCallbacksRun()).toBeGreaterThan(0), { timeout: 5000 });
    screen.dispose();

    // Code that sets a user agent of its own afterwards, in strict mode, still can.
    expect(runInContext('"use strict"; navigator.userAgent = "set later"; navigator.userAgent', realm.context)).toBe("set later");
  });

  it("leaves a user agent and platform the runtime reports alone", () => {
    const { context } = reactNativeRealm({ product: "ReactNative", userAgent: "Mozilla/5.0 (iPhone) Safari", platform: "iPhone" });
    load(context, resolve(here, "xterm-platform.ts"));
    expect({ ...(runInContext("navigator", context) as object) }).toEqual({ product: "ReactNative", userAgent: "Mozilla/5.0 (iPhone) Safari", platform: "iPhone" });
  });
});
