import { invoke } from "./api";
import reserved from "../../src-tauri/src/store/environment_reserved.json";

/**
 * One variable of a scope. `user` and `repository` rows are TerminalX's own
 * (Keychain, or stored plainly by choice); the others are names the repository
 * files or managed policy set, listed as Layered configuration lists them,
 * never with their values.
 */
export type EnvironmentSource = "user" | "repository" | "repositoryShared" | "repositoryLocal" | "managed";
export interface EnvironmentRow {
  name: string;
  scope: EnvironmentSource;
  overridden: boolean;
  /** In the Keychain. Absent from older runtimes: treated as true. */
  secret?: boolean;
  /** Only for a value the user chose to store plainly. */
  value?: string;
  /** Personal rows: Git common directories of repositories that override it. */
  overriddenIn?: string[];
}
/** `secret: false` stores the value plainly; omitted keeps it in the Keychain. */
export interface EnvironmentInput { name: string; value: string; secret?: boolean }

export const environment = {
  list: (projectPath: string | null) => invoke<EnvironmentRow[]>("environment_list", { projectPath }),
  reveal: (projectPath: string | null, name: string) => invoke<string>("environment_reveal", { projectPath, name }),
  copy: (projectPath: string | null, name: string) => invoke<void>("environment_copy", { projectPath, name }),
  save: (projectPath: string | null, inputs: EnvironmentInput[], previous: string | null = null) => invoke<boolean>("environment_save", { projectPath, inputs, previous }),
  delete: (projectPath: string | null, name: string) => invoke<boolean>("environment_delete", { projectPath, name }),
  readFile: (projectPath: string, path: string) => invoke<string>("environment_read_file", { projectPath, path }),
  changed: (id: string) => invoke<{ changed: boolean; unavailable: boolean }>("environment_changed", { id }),
};

const RESERVED = new Set(reserved.names);
export function environmentNameError(name: string): string | null {
  if (name.length > 128 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return "Use a name matching [A-Z_][A-Z0-9_]* (at most 128 characters).";
  if (RESERVED.has(name) || reserved.prefixes.some((prefix) => name.startsWith(prefix))) return "This name is reserved by TerminalX.";
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

export const isPrivateRow = (row: EnvironmentRow) => row.scope === "user" || row.scope === "repository";
export const isSecretRow = (row: EnvironmentRow) => row.secret !== false;

const SECRET_WORDS = new Set(["KEY", "KEYS", "APIKEY", "TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "PASSWD", "PASS", "PWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS", "AUTH", "PRIVATE", "SEED", "COOKIE", "SALT", "SIGNATURE", "DSN", "CERT"]);
const SECRET_PREFIXES = /^(sk[-_]|rk_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abposr]-|AKIA|ASIA|AIza|ya29\.|sntry[su]_|npm_|phc_|shpat_|SG\.|eyJ)/;

/**
 * Whether a value should go to the Keychain. Deliberately generous: a value
 * stored there by mistake costs a Reveal click, one stored plainly by mistake
 * sits in a settings file. Names with a secret word (API_KEY, GH_TOKEN,
 * DB_PASSWORD, SENTRY_DSN, …), known credential shapes (sk-…, ghp_…, AKIA…,
 * JWTs, PEM keys, URLs with a password) and long random strings count.
 */
export function looksSecret(name: string, value: string): boolean {
  const words = name.split("_").filter(Boolean);
  if (words.some((word) => SECRET_WORDS.has(word)) || /(TOKEN|SECRET|PASSWORD|APIKEY)$/.test(name)) return true;
  const text = value.trim();
  if (!text) return false;
  if (SECRET_PREFIXES.test(text) || text.includes("-----BEGIN") || /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i.test(text)) return true;
  return randomLooking(text);
}

function randomLooking(text: string): boolean {
  // Paths, URLs and command-line flags are not random, however long.
  if (text.length < 24 || /\s/.test(text) || /^[-/~.]/.test(text) || text.includes("://") || !/^[A-Za-z0-9+/=_.-]+$/.test(text)) return false;
  if (!/[0-9]/.test(text) || !/[A-Z]/.test(text) || !/[a-z]/.test(text)) return false;
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) entropy -= (n / text.length) * Math.log2(n / text.length);
  return entropy >= 3.5;
}

/** Where an input goes: the Keychain switch on keeps secret-looking values there. */
export const withStorage = (inputs: EnvironmentInput[], keepSecrets: boolean): EnvironmentInput[] =>
  inputs.map(({ name, value }) => ({ name, value, secret: keepSecrets && looksSecret(name, value) }));

export const REPOSITORY_FILES: Partial<Record<EnvironmentSource, string>> = {
  repositoryShared: ".terminalx/settings.json",
  repositoryLocal: ".terminalx/settings.local.json",
  managed: "Managed policy",
};

/** The project a repository's Git common directory belongs to, for a label. */
export function repositoryName(commonDir: string, projects: { name: string; path: string }[]): string {
  const root = commonDir.replace(/\/\.git\/?$/, "");
  return projects.find((p) => p.path.replace(/\/$/, "") === root)?.name ?? root.split("/").filter(Boolean).pop() ?? root;
}

/**
 * The "Applies to" column: where the value comes from and what it overrides.
 * On the Personal page a row applies to all projects unless a project
 * overrides it; on a project page it is from Personal, overrides Personal,
 * this project's own, or a repository file.
 */
export function appliesTo(row: EnvironmentRow, rows: EnvironmentRow[], page: "personal" | "repository", projects: { name: string; path: string }[] = []): string {
  if (page === "personal") {
    if (row.scope === "managed") return "Managed policy";
    return row.overriddenIn?.length ? `overridden in ${row.overriddenIn.map((dir) => repositoryName(dir, projects)).join(", ")}` : "All projects";
  }
  if (row.scope === "user") return "from Personal";
  const overridesPersonal = rows.some((other) => other.scope === "user" && other.name === row.name);
  const source = row.scope === "repository" ? "This project" : REPOSITORY_FILES[row.scope] ?? row.scope;
  return overridesPersonal ? (row.scope === "repository" ? "overrides Personal" : `${source} · overrides Personal`) : source;
}

/** What TerminalX itself sets in every agent and terminal it starts. */
export const TERMINALX_VARIABLES: { names: string; description: string }[] = [
  { names: "TERM, COLORTERM, TERM_PROGRAM", description: "Terminal capabilities and application name" },
  { names: "PATH", description: "Login shell executable search path" },
  { names: "RACCOON", description: "TerminalX terminal marker" },
  { names: "RACCOON_SESSION_ID, RACCOON_TAB_ID", description: "Agent session and tab identity" },
  { names: "TERMINALX_PORT", description: "First port of this workspace's block of 10, the same each launch" },
  { names: "TERMINALX_PORTS", description: "All 10 ports of the workspace's block, comma-separated" },
  { names: "TERMINALX_NEXT_SOCKET", description: "Local control socket" },
  { names: "RACCOON_HOOK_SOCKET", description: "Agent hook socket" },
  { names: "TERMINALX_NEXT_TOKEN, RACCOON_HOOK_TOKEN", description: "Private control and hook credentials" },
  { names: "CODEX_HOME", description: "Codex launch configuration directory" },
];

/** Variables the agents read, shown on a project page with whether each is set. */
export const AGENT_VARIABLES: { name: string; description: string }[] = [
  { name: "ANTHROPIC_API_KEY", description: "Lets Claude Code use an API key instead of your Claude login." },
  { name: "ANTHROPIC_BASE_URL", description: "Points Claude Code at another Anthropic-compatible endpoint." },
  { name: "CLAUDE_CODE_USE_BEDROCK", description: "Sends Claude Code requests to Amazon Bedrock." },
  { name: "AWS_REGION", description: "Region for Bedrock requests." },
  { name: "AWS_PROFILE", description: "Named AWS profile for Bedrock credentials." },
  { name: "CLAUDE_CODE_USE_VERTEX", description: "Sends Claude Code requests to Google Vertex AI." },
  { name: "ANTHROPIC_VERTEX_PROJECT_ID", description: "Google Cloud project for Vertex requests." },
  { name: "CLOUD_ML_REGION", description: "Region for Vertex requests." },
  { name: "OPENAI_API_KEY", description: "Lets Codex use an API key instead of ChatGPT sign-in." },
  { name: "OPENAI_BASE_URL", description: "Points Codex at another OpenAI-compatible endpoint." },
  { name: "HTTPS_PROXY", description: "Proxy for the agents' outgoing requests." },
  { name: "NODE_EXTRA_CA_CERTS", description: "Extra certificate authorities for Node-based agents." },
];

export interface DocumentedVariable { name: string; description: string | null; status: string; set: boolean }

/**
 * The project page's documented variables: those the agents read, then the
 * names the repository files declare, each with where it is set (or not).
 */
export function documentedVariables(rows: EnvironmentRow[]): DocumentedVariable[] {
  const status = (name: string) => {
    const set = rows.filter((row) => row.name === name);
    const own = set.find((row) => row.scope !== "user" && !row.overridden) ?? set.find((row) => row.scope !== "user");
    if (own) return { set: true, status: own.scope === "repository" ? "Set in this project" : `Set in ${REPOSITORY_FILES[own.scope]}` };
    return set.length ? { set: true, status: "Set in Personal" } : { set: false, status: "Not set" };
  };
  const files = [...new Set(rows.filter((row) => row.scope === "repositoryShared" || row.scope === "repositoryLocal").map((row) => row.name))]
    .filter((name) => !AGENT_VARIABLES.some((v) => v.name === name)).sort();
  return [
    ...AGENT_VARIABLES.map(({ name, description }) => ({ name, description, ...status(name) })),
    ...files.map((name) => ({ name, description: null, ...status(name) })),
  ];
}
