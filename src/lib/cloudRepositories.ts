import type { CloudSelectedRepository } from "@/lib/api";

export function parseGithubRepository(value: string): { cloneUrl: string; fullName: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value.trim());
  if (!match || match.slice(1).some((part) => [".", "..", ".git"].includes(part!) || part!.length > 255)) return null;
  const fullName = `${match[1]}/${match[2]}`;
  return { fullName, cloneUrl: `https://github.com/${fullName}.git` };
}

export function repositoryGroups(repositories: CloudSelectedRepository[]): { name: string; repositories: CloudSelectedRepository[] }[] {
  const groups = new Map<string, CloudSelectedRepository[]>();
  for (const repository of repositories) {
    const name = repository.state === "accessible" ? repository.fullName.split("/")[0]! : "Not connected";
    groups.set(name, [...(groups.get(name) ?? []), repository]);
  }
  return [...groups].sort(([a], [b]) => a === "Not connected" ? 1 : b === "Not connected" ? -1 : a.localeCompare(b)).map(([name, repositories]) => ({ name, repositories }));
}

/** Mirrors the server's uniqueTargetDirectories; the preview is the actual runtime path. */
export function clonePaths(repositories: { fullName: string }[]): string[] {
  const used = new Set<string>();
  return repositories.map((repository) => {
    const base = repository.fullName.split("/").pop()!;
    let directory = base;
    let suffix = 2;
    while (used.has(directory)) directory = `${base}-${suffix++}`;
    used.add(directory);
    return `/var/lib/terminalx/workspace/${directory}`;
  });
}
