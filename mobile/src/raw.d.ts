// A module imported as its source text (`import text from "./file.ts?raw"`), used by tests.
declare module "*?raw" {
  const source: string;
  export default source;
}
