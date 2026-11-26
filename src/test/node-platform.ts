// The `node` project's tests run with Node's own `navigator`, whose `platform`
// follows the host ("MacIntel" on a Mac, "Linux x86_64" on Linux). The app's
// platform words (`src/lib/platform.ts`: "this Mac", "this computer") are read
// from it once at load, so the same test said different things on a Mac and on
// CI. Pin it to the Linux CI runner's value so every host runs the tests CI
// runs. Tests of a particular system pass its name to `detectPlatform` or
// `profileFor` themselves.
Object.defineProperty(globalThis.navigator, "platform", { value: "Linux x86_64", configurable: true });
