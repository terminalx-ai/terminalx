/**
 * xterm.js works out which platform it runs on while its module is being
 * evaluated. Outside Node (it tests for `process.title`) it reads
 * `navigator.userAgent` and `navigator.platform` and calls string methods on
 * them. React Native's `navigator` is only `{ product: "ReactNative" }`, so
 * loading the emulator threw, and with it every session screen (#726).
 *
 * Import this before `@xterm/headless`. It fills in whichever of the two is
 * missing with an empty string, meaning "not reported", and leaves a value the
 * runtime already gives (a browser, Node) alone. An empty string matches none
 * of xterm's browser or OS checks, and it is falsy, so a library that treats a
 * user agent as a sign it runs in a browser still sees none. The headless
 * emulator does not draw differently by platform: the only setting these
 * checks change is whether a right click selects a word, and the phone has no
 * mouse.
 */

type Reported = "userAgent" | "platform";

const scope = globalThis as { navigator?: Partial<Record<Reported, unknown>> };
const navigator = (scope.navigator ??= {});

for (const name of ["userAgent", "platform"] as const) {
  if (typeof navigator[name] === "string") continue;
  // An own property even where a prototype getter answers undefined; writable, so
  // code that sets its own user agent later still can.
  Object.defineProperty(navigator, name, { value: "", writable: true, enumerable: true, configurable: true });
}
