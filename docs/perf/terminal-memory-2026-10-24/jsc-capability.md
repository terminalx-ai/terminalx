# Installed JSC attribution capability — 2026-10-24

This follow-up to `c5f000c4` supersedes the suggestion that a custom WebKit
build is the immediate prerequisite for **all** further cell attribution.
The assigned guest's installed `jsc` shell can expose a named function's
CodeBlock and a native-addressed GC heap graph. Ordinary WKWebView rejects
the restricted hook. This is a useful diagnostic route, not a production fix.
The original physical failure and the unprofiled guest **+68.4607671% FAIL**
remain unchanged. No new comparative memory measurements or full soaks ran.

## Primary-source feasibility audit

- [WebKit logging documentation](https://docs.webkit.org/Build%20%26%20Debug/Logging.html)
  documents JSC environment/command-line options and `--options` discovery.
- [OptionsList.h](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/OptionsList.h)
  marks `useDollarVM` restricted.
  [jsc.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/jsc.cpp)
  explicitly enables restricted options for the shell. This explains why the
  shell is a distinct supported diagnostic environment; its success must not
  be assumed to transfer to a browser process.
- [JSDollarVM.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/tools/JSDollarVM.cpp)
  implements `codeBlockFor`, `dumpSourceFor`, `dumpCell` and `dumpHeapSnapshot`.
  The snapshot builds a GC-debugging graph and performs full collection.
  [HeapSnapshotBuilder.cpp](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/heap/HeapSnapshotBuilder.cpp)
  documents the seven-field node layout, including labels, cell addresses and
  wrapped native addresses. Current upstream sources describe the mechanism;
  the actual installed capabilities below were tested, not inferred from main.
- [Apple's current downloads](https://developer.apple.com/safari/resources/)
  offer Safari Technology Preview 255 for macOS 26.4+, compatible with the
  guest's stated OS requirement. It was not downloaded or executed; this does
  not verify private diagnostic hooks or matching system-engine behavior.
- [Official WebKit build archives](https://webkit.org/build-archives/) list a
  Tahoe universal release archive at `324600@main`. HTTP HEAD reports
  **331710829 compressed bytes**. Reading only its ZIP index (1754824 bytes
  transferred) finds **12789 entries / 1121487909 uncompressed bytes**, including
  jsc and MiniBrowser, and no `.dSYM` entries. The archive was not downloaded
  or launched. A Tahoe target label does not establish binary compatibility
  or symbol completeness; those remain unverified. No debug archive was
  established by this inspection of the published release artifact.
- A full source build requires [Xcode and the Metal toolchain](https://webkit.org/build-tools/).
  WebKit's [debug build](https://webkit.org/building-webkit/) includes symbols
  and assertions. The guest has only Command Line Tools, 2 vCPU/6 GiB RAM and
  113 GiB free disk. Exact full-build time/disk use was not measured and is not
  promised to fit. No Xcode/Metal download or source build was started.
  [Per-class malloc breakdown](https://docs.webkit.org/Infrastructure/MemoryInspection.html)
  requires build-time WebKit/bmalloc flags; this is not an existing runtime
  switch we can turn on in the system framework.

## Reproduced installed-shell diagnostic

Guest: `local:tx-queue-232`, macOS 26.5.2 (25F84), arm64.
Executable: `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`.
SHA-256: `ac4ab8952b32a3d2110cde476f096e7884d0ad4c879b0e7bd0b9919be8c8728e`.

The synthetic function computes a checksum of 4096. The plain DFG-disassembly
attempt exited 0 but produced no disassembly; it is preserved as inconclusive.
The bytecode attempt succeeded, followed by explicit `$vm` introspection:

```sh
jsc --useDollarVM=true /tmp/tx232-jsc-capability/known-owner.js
jsc --useDollarVM=true /tmp/tx232-jsc-capability/known-owner-snapshot.js
```

Both exited 0. `known-owner.js` prints the function's CodeBlock, source and cell
layout. The snapshot variant produces a 165717-byte log. A parser verifies the
following graph edges and matches addresses against the independently printed
CodeBlock description in the same process:

| Node | Native address | Reported bytes |
| --- | --- | ---: |
| Function, label `tx232KnownFunction` | `0x113197900` | 32 |
| FunctionExecutable | `0x1131a9800` | 128 |
| FunctionCodeBlock | `0x1131dc2c0` | 864 |

The verifier requires the Function → FunctionExecutable → FunctionCodeBlock
edges, not just matching text. The printed optimized CodeBlock at
`0x1131dc3a0` is absent from the collected graph. Snapshot collection can change
code liveness, so this technique cannot describe an untouched pre-GC endpoint.
These node sizes are not native physical-footprint attribution or total JIT
code bytes. The diagnostic demonstrates a capability missing from `leaks`
conservative native-block graphs, without asserting allocator occupancy yet.

## Browser boundary tested, not bypassed

A 1.4 KB Objective-C harness compiled using guest Command Line Tools and system
Cocoa/WebKit (exit 0). It creates an offscreen WKWebView with a nonpersistent
store, no window, prohibited activation, and a 20-second exit timeout. It runs
only synthetic JavaScript with a disposable HOME. Passing process-local
`JSC_useDollarVM=true` and `__XPC_JSC_useDollarVM=true` produced:

```text
ERROR: invalid option: JSC_useDollarVM=true
{"checksum":4096,"dollarVM":"undefined","codeBlock":null}
```

The harness exited 0 after reporting the unavailable capability. This is **not**
a successful browser attribution test. No private preference, framework patch,
entitlement change, debugger injection or security override was attempted.
No host GUI or TerminalX UI was operated; the harness exited itself.

## Real parser capability and bounded next experiment

Loading the shipped browser xterm bundle into the shell failed first on absent
`console`, then on `document`. Those failures are preserved; inventing a DOM
would undermine renderer conclusions. Instead, the installed xterm **6.0.0**
`common/CoreTerminal.ts` and its real dependencies were bundled with the
repository's esbuild 0.28.2. Every input is hashed. No xterm source was edited.
This unminified diagnostic bundle is not the production browser bundle.

The final harness supplies only console logging, navigator platform strings,
and `window = globalThis` for the common task-queue capability check. No timer
callbacks are suppressed or mocked. It uses synchronous `InputHandler.parse`
directly, verifies the ANSI-colored line becomes `TX232_SYNTHETIC`, then calls
`dispose()`. It retains the real **80×24 / 10000 scrollback** settings. Result:

```text
{"phase":"parsed","line":"TX232_SYNTHETIC","cols":80,"rows":24,"scrollback":10000}
TX232_PARSER parse#Eet3vP:[0x1138b66a0->0x113394f00, LLIntFunctionCall, 1435 (StrictMode)]
{"phase":"disposed"}
```

This exited 0 and proves the parser can be exercised with CodeBlock attribution
in installed JSC. It excludes DOM, WebGL, Tauri channels and React stores, and
therefore cannot alone explain or validate their memory behavior.

`parser-ownership.js` prepares a **not-yet-executed** comparison: separate shell
processes loading the same common bundle, library-only control versus eight
sequential terminals parsing 5000 synthetic ANSI lines each and disposing.
Both capture baseline/endpoint GC-debugging graphs. Output assertions and an
unexpected asynchronous-parser guard prevent silently skipping work. The
script passed `node --check`; its comparison has **not** passed or run.

**Coordinator scheduling request:** reserve 10 quiet minutes for the assigned
guest and pause competing heavy host builds before this comparison. No host
UI access, many-GB downloads or native application build is needed. Bound each
process to 30 seconds and stop on harness failure. Compare live terminal/parser
cells and function-owned CodeBlocks; do not treat collection-induced drops as
production acceptance. If timer support becomes necessary, stop and implement
a faithful scheduler or narrow the question explicitly rather than discarding
callbacks. This is the next useful test, not another whole-app soak.

## Validation and evidence

The one-function graph verifier passed; the minimal common-parser probe passed;
the offscreen native harness compiled and correctly reported an unavailable
hook. Failed/inconclusive alternatives are retained. No runtime repository code
changed, so the four checks recorded for `550d4522` remain the last full code
checks and were not rerun here. Artifact hashes and the prepared script syntax
were checked. Guest capability probes used about 1.2 MiB of files; the final
load audit was 1.28/1.16/1.58. No timing claim is made. No reservation is held.

`jsc-capability-evidence.tar.gz` includes the raw logs, reproducible sources,
graph verifier, parser bundle/provenance, prepared comparison, archive index and
environment audit. `jsc-capability-manifest.json` records hashes and file sizes.
No toolchain, engine archive, credential or app data was transferred.
