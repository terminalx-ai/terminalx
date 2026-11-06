import { invoke } from "./api";

export interface EnvironmentRow { name: string; scope: "user" | "repository"; overridden: boolean }
export interface EnvironmentInput { name: string; value: string }

export const environment = {
  list: (projectPath: string | null) => invoke<EnvironmentRow[]>("environment_list", { projectPath }),
  reveal: (projectPath: string | null, name: string) => invoke<string>("environment_reveal", { projectPath, name }),
  save: (projectPath: string | null, inputs: EnvironmentInput[], previous: string | null = null) => invoke<void>("environment_save", { projectPath, inputs, previous }),
  delete: (projectPath: string | null, name: string) => invoke<void>("environment_delete", { projectPath, name }),
  readFile: (projectPath: string, path: string) => invoke<string>("environment_read_file", { projectPath, path }),
  changed: (id: string) => invoke<boolean>("environment_changed", { id }),
};

const RESERVED = new Set(["TERMINALX", "RACCOON", "TERM", "COLORTERM", "TERM_PROGRAM", "PATH", "CODEX_HOME", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_BRIDGE_SESSION_ID"]);
export function environmentNameError(name: string): string | null {
  if (name.length > 128 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return "Use a name matching [A-Z_][A-Z0-9_]* (at most 128 characters).";
  if (RESERVED.has(name) || name.startsWith("TERMINALX_") || name.startsWith("RACCOON_")) return "This name is reserved by TerminalX.";
  return null;
}

/** Literal dotenv assignments only: no interpolation, commands or multiline values. */
export function parseLocalEnv(text: string, existing: string[] = []) {
  const inputs: EnvironmentInput[] = [];
  const errors: string[] = [];
  const names = new Set(existing);
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.replace(/^export\s+/, "");
    const split = assignment.indexOf("=");
    const name = split < 0 ? "" : assignment.slice(0, split).trim();
    let value = split < 0 ? "" : assignment.slice(split + 1).trim();
    let error = split < 0 ? "Use NAME=value." : environmentNameError(name);
    if (!error && names.has(name)) error = "Duplicate name in this scope.";
    if (!error && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      if (end < 0 || (value.slice(end + 1).trim() && !value.slice(end + 1).trim().startsWith("#"))) error = "Use a single line with matching quotes.";
      else value = value.slice(1, end);
    } else if (!error) {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    if (!error && (value.includes("\0") || new TextEncoder().encode(value).length > 64 * 1024)) error = "Values must contain no NUL and be at most 64 KiB.";
    if (error) errors.push(`Line ${i + 1}: ${error}`);
    else { inputs.push({ name, value }); names.add(name); }
  }
  return { inputs, errors };
}
