/**
 * Curated common developer languages supported by Shiki syntax highlighting.
 * Shared between `vite.config.ts` (to prune unused grammars like `emacs-lisp` and
 * `wolfram` from the production bundle) and `Markdown.tsx` (for runtime consistency).
 */
export const SHIKI_COMMON_LANGS = new Set<string>([
  "typescript", "tsx", "javascript", "jsx",
  "json", "jsonc", "json5",
  "html", "css", "scss", "less",
  "markdown", "mdx",
  "rust", "python", "go", "java", "kotlin", "swift", "c", "cpp", "csharp", "objective-c",
  "ruby", "php", "sql",
  "shellscript", "shellsession", "powershell",
  "yaml", "toml", "ini", "dotenv",
  "docker", "diff", "graphql", "xml",
  "lua", "zig", "hcl", "terraform", "make", "cmake",
  "svelte", "vue", "prisma", "proto", "nginx", "nix", "latex",
  "dart", "elixir", "scala", "haskell", "ocaml", "groovy", "perl", "r",
  "csv", "http", "log",
]);

/** Common language aliases accepted by `supportsLanguage` alongside canonical Shiki ids. */
export const SHIKI_COMMON_ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  console: "shellsession",
  yml: "yaml",
  dockerfile: "docker",
  makefile: "make",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  md: "markdown",
  kt: "kotlin",
  kts: "kotlin",
  objc: "objective-c",
  ps1: "powershell",
  pwsh: "powershell",
  tf: "terraform",
  tfvars: "terraform",
  gql: "graphql",
  protobuf: "proto",
  tex: "latex",
  hs: "haskell",
  ml: "ocaml",
  ex: "elixir",
  exs: "elixir",
  pl: "perl",
  env: "dotenv",
  patch: "diff",
};

export function normalizeShikiLang(language: string): string {
  const key = language.trim().toLowerCase();
  return SHIKI_COMMON_ALIASES[key] ?? key;
}

export function isCommonShikiLang(language: string): boolean {
  return SHIKI_COMMON_LANGS.has(normalizeShikiLang(language));
}
