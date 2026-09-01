/** A path with the home directory folded to ~ and long middles elided. */
export function shortPath(p: string, cwd?: string): string {
  if (!p) return "";
  let s = p;
  if (cwd && s.startsWith(cwd + "/")) s = s.slice(cwd.length + 1);
  const home = typeof navigator !== "undefined" ? undefined : undefined;
  void home;
  const m = s.match(/^\/Users\/[^/]+|^\/home\/[^/]+/);
  if (m) s = "~" + s.slice(m[0].length);
  return s;
}

export function fileName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

export function extOf(p: string): string {
  const name = fileName(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  rs: "rust",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  dockerfile: "docker",
};

export function langOf(p: string): string {
  const e = extOf(p);
  if (LANG[e]) return LANG[e];
  if (fileName(p).toLowerCase() === "dockerfile") return "docker";
  return "text";
}
