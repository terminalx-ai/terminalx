const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,39})\s*\}\}/g;

/** The `{{name}}` placeholders in a snippet, each once, in order. */
export function snippetVariables(text: string): string[] {
  return [...new Set([...text.matchAll(VARIABLE)].map((match) => match[1]))];
}

/** The snippet with its placeholders filled in, in one pass: a value is never read as a placeholder. One left empty stays as written. */
export function fillSnippet(text: string, values: Record<string, string>): string {
  return text.replace(VARIABLE, (whole, name: string) => (Object.hasOwn(values, name) && values[name] ? values[name] : whole));
}
