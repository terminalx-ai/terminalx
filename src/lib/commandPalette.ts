import type { HarnessInfo, Project, SessionEntry, Workspace } from "@/types/session";

export type PaletteEntityGroup = "sessions" | "workspaces" | "projects";

interface SearchField {
  text: string;
  normalized: string;
  target: "primary" | "secondary" | "keywords";
  weight: number;
}

export interface PaletteEntityBase {
  id: string;
  group: PaletteEntityGroup;
  primary: string;
  secondary: string;
  recentAt: number;
  searchFields: SearchField[];
}

export interface PaletteSessionItem extends PaletteEntityBase {
  group: "sessions";
  sessionId: string;
  projectPath: string;
  branch: string | null;
  agents: string[];
  modified: string;
}

export interface PaletteWorkspaceItem extends PaletteEntityBase {
  group: "workspaces";
  projectPath: string;
  workspace: Workspace;
  projectName: string;
}

export interface PaletteProjectItem extends PaletteEntityBase {
  group: "projects";
  project: Project;
}

export type PaletteEntityItem = PaletteSessionItem | PaletteWorkspaceItem | PaletteProjectItem;

export interface PaletteIndex {
  sessions: PaletteSessionItem[];
  workspaces: PaletteWorkspaceItem[];
  projects: PaletteProjectItem[];
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface PaletteMatch<T extends PaletteEntityBase = PaletteEntityItem> {
  item: T;
  score: number;
  primaryRanges: MatchRange[];
  secondaryRanges: MatchRange[];
}

export interface PaletteSearchGroups {
  sessions: PaletteMatch<PaletteSessionItem>[];
  workspaces: PaletteMatch<PaletteWorkspaceItem>[];
  projects: PaletteMatch<PaletteProjectItem>[];
}

export type SmartInput =
  | {
      kind: "github";
      type: "issue" | "pull";
      number: number;
      owner: string | null;
      repo: string | null;
      url: string | null;
    }
  | { kind: "path"; path: string };

const EMPTY_INDEX: PaletteIndex = { sessions: [], workspaces: [], projects: [] };

function normalize(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD");
}

function cleanPath(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function parseDate(value?: string | null): number {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function searchFields(primary: string, secondary: string, keywords: string[]): SearchField[] {
  return [
    { text: primary, normalized: normalize(primary), target: "primary", weight: 0 },
    { text: secondary, normalized: normalize(secondary), target: "secondary", weight: 18 },
    ...keywords.filter(Boolean).map((text) => ({ text, normalized: normalize(text), target: "keywords" as const, weight: 36 })),
  ];
}

/** Build normalized palette documents when the shared store changes, never per keystroke. */
export function buildPaletteIndex(
  sessions: SessionEntry[],
  projects: Project[],
  workspaces: Record<string, Workspace[]>,
  harnesses: HarnessInfo[],
): PaletteIndex {
  if (!sessions.length && !projects.length) return EMPTY_INDEX;

  const projectByPath = new Map(projects.map((project) => [project.path, project]));
  const harnessById = new Map(harnesses.map((harness) => [harness.id, harness.name]));
  const workspaceByPath = new Map<string, Workspace>();
  for (const list of Object.values(workspaces)) {
    for (const workspace of list) workspaceByPath.set(cleanPath(workspace.path), workspace);
  }

  const indexedSessions = sessions
    .filter((session) => !session.archived)
    .map((session): PaletteSessionItem => {
      const project = projectByPath.get(session.projectPath);
      const projectName = project?.name ?? session.projectPath.split("/").pop() ?? session.projectPath;
      const workspace = workspaceByPath.get(cleanPath(session.cwd));
      const branch = session.branch ?? workspace?.branch ?? null;
      const agents = [
        ...new Set(
          session.tabs.map((tab) => harnessById.get(tab.harness) ?? tab.harness),
        ),
      ];
      const agentLabel = agents.length ? agents.join(", ") : "Workspace";
      const location = branch ?? workspace?.name ?? session.cwd.split("/").pop() ?? session.cwd;
      const secondary = `${projectName} · ${location} · ${agentLabel}`;
      return {
        id: `session:${session.id}`,
        group: "sessions",
        sessionId: session.id,
        projectPath: session.projectPath,
        branch,
        agents,
        modified: session.modified,
        primary: session.title,
        secondary,
        recentAt: parseDate(session.modified),
        searchFields: searchFields(session.title, secondary, [session.cwd, session.issue?.identifier ?? "", session.issue?.title ?? ""]),
      };
    });

  const lastSessionByPath = new Map<string, number>();
  const lastSessionByProject = new Map<string, number>();
  for (const session of sessions) {
    const modified = parseDate(session.modified);
    const cwd = cleanPath(session.cwd);
    lastSessionByPath.set(cwd, Math.max(lastSessionByPath.get(cwd) ?? 0, modified));
    lastSessionByProject.set(session.projectPath, Math.max(lastSessionByProject.get(session.projectPath) ?? 0, modified));
  }

  const indexedWorkspaces: PaletteWorkspaceItem[] = [];
  for (const project of projects) {
    if (project.archived) continue;
    for (const workspace of workspaces[project.path] ?? []) {
      const primary = workspace.branch ?? workspace.name;
      const secondary = `${project.name} · ↑${workspace.ahead} ↓${workspace.behind}`;
      indexedWorkspaces.push({
        id: `workspace:${workspace.path}`,
        group: "workspaces",
        projectPath: project.path,
        workspace,
        projectName: project.name,
        primary,
        secondary,
        recentAt: lastSessionByPath.get(cleanPath(workspace.path)) ?? parseDate(project.lastOpened),
        searchFields: searchFields(primary, secondary, [workspace.name, workspace.path, project.path]),
      });
    }
  }

  const indexedProjects = projects
    .filter((project) => !project.archived)
    .map((project): PaletteProjectItem => ({
      id: `project:${project.path}`,
      group: "projects",
      project,
      primary: project.name,
      secondary: project.path,
      recentAt: Math.max(parseDate(project.lastOpened), lastSessionByProject.get(project.path) ?? 0),
      searchFields: searchFields(project.name, project.path, []),
    }));

  const recent = <T extends PaletteEntityBase>(items: T[]): T[] =>
    items.sort((a, b) => b.recentAt - a.recentAt || a.primary.localeCompare(b.primary));

  return {
    sessions: recent(indexedSessions),
    workspaces: recent(indexedWorkspaces),
    projects: recent(indexedProjects),
  };
}

interface TextMatch {
  score: number;
  ranges: MatchRange[];
}

function fuzzyText(normalized: string, token: string): TextMatch | null {
  const exact = normalized.indexOf(token);
  if (exact >= 0) {
    const boundary = exact === 0 || /[\s/_.-]/.test(normalized[exact - 1] ?? "");
    return {
      score: exact * 2 - (exact === 0 ? 90 : boundary ? 48 : 0) - token.length * 3,
      ranges: [{ start: exact, end: exact + token.length }],
    };
  }

  const positions: number[] = [];
  let cursor = 0;
  for (const char of token) {
    const at = normalized.indexOf(char, cursor);
    if (at < 0) return null;
    positions.push(at);
    cursor = at + 1;
  }
  const gaps = positions.slice(1).reduce((sum, position, index) => sum + position - positions[index] - 1, 0);
  const ranges = positions.map((position) => ({ start: position, end: position + 1 }));
  return { score: 100 + positions[0] * 2 + gaps * 5 - token.length, ranges };
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function matchItem<T extends PaletteEntityBase>(item: T, query: string): PaletteMatch<T> | null {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { item, score: 0, primaryRanges: [], secondaryRanges: [] };

  let score = 0;
  const primaryRanges: MatchRange[] = [];
  const secondaryRanges: MatchRange[] = [];
  for (const token of tokens) {
    let best: { field: SearchField; match: TextMatch; score: number } | null = null;
    for (const field of item.searchFields) {
      const match = fuzzyText(field.normalized, token);
      if (!match) continue;
      const candidateScore = match.score + field.weight;
      if (!best || candidateScore < best.score) best = { field, match, score: candidateScore };
    }
    if (!best) return null;
    score += best.score;
    if (best.field.target === "primary") primaryRanges.push(...best.match.ranges);
    if (best.field.target === "secondary") secondaryRanges.push(...best.match.ranges);
  }
  return { item, score, primaryRanges: mergeRanges(primaryRanges), secondaryRanges: mergeRanges(secondaryRanges) };
}

export function rankPaletteItems<T extends PaletteEntityBase>(items: T[], query: string): PaletteMatch<T>[] {
  const matches = items.flatMap((item) => matchItem(item, query) ?? []);
  if (!query.trim()) return matches;
  return matches.sort(
    (a, b) => a.score - b.score || b.item.recentAt - a.item.recentAt || a.item.primary.localeCompare(b.item.primary),
  );
}

export function searchPaletteIndex(index: PaletteIndex, query: string): PaletteSearchGroups {
  return {
    sessions: rankPaletteItems(index.sessions, query),
    workspaces: rankPaletteItems(index.workspaces, query),
    projects: rankPaletteItems(index.projects, query),
  };
}

/** Recognise decisive inputs before ordinary fuzzy search. */
export function parseSmartInput(raw: string): SmartInput | null {
  const value = raw.trim();
  const github = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(value);
  if (github) {
    return {
      kind: "github",
      type: github[3].toLowerCase() === "pull" ? "pull" : "issue",
      number: Number(github[4]),
      owner: github[1],
      repo: github[2].replace(/\.git$/i, ""),
      url: `https://github.com/${github[1]}/${github[2].replace(/\.git$/i, "")}/${github[3]}/${github[4]}`,
    };
  }
  const number = /^#(\d+)$/.exec(value);
  if (number) return { kind: "github", type: "issue", number: Number(number[1]), owner: null, repo: null, url: null };

  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol === "file:") return { kind: "path", path: cleanPath(decodeURIComponent(url.pathname)) };
    } catch {
      return null;
    }
  }
  if (value.startsWith("/") && value.length > 1) return { kind: "path", path: cleanPath(value) };
  return null;
}

export type PaletteNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Loop through selectable rows while headers and “more” controls stay outside the cursor. */
export function movePaletteSelection(current: number, count: number, key: PaletteNavigationKey): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return current < 0 || current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}
