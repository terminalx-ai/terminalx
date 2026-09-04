import { useEffect, useMemo, useState } from "react";
import { ChevronDown, FileCode2, FolderOpen, Loader2, RefreshCw, Search } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { AgentMark } from "@/components/AgentMark";
import { Markdown } from "@/components/chat/Markdown";
import { FileTypeIcon } from "@/components/files/FileTypeIcon";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { errorMessage, skills } from "@/lib/api";
import type { DiscoveredSkill, SkillDetail, SkillSource } from "@/types/skills";

type AgentFilter = "claude" | "codex" | "both" | null;

const SOURCE_LABEL: Record<SkillSource, string> = {
  personal: "Personal",
  repo: "Repo",
  plugin: "Plugin",
  bundled: "Bundled",
};

function reaches(skill: DiscoveredSkill, agent: Exclude<AgentFilter, null>) {
  return agent === "both" ? skill.agents.includes("claude") && skill.agents.includes("codex") : skill.agents.includes(agent);
}

function FilterChip({ active, label, count, onClick }: { active: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        active
          ? "border-ring/50 bg-selected text-foreground"
          : "border-hairline-strong bg-veil-card text-muted-foreground hover:bg-veil-raised hover:text-foreground",
      )}
    >
      {label}
      <span className={cn("tabular-nums", active ? "text-muted-foreground" : "text-faint")}>{count}</span>
    </button>
  );
}

/** A full-area reader over the skills the active checkout's agents can reach. */
export function SkillsView({ projectPath, initialAgent }: { projectPath: string | null; initialAgent: string | null }) {
  const [rows, setRows] = useState<DiscoveredSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<AgentFilter>(initialAgent === "claude" || initialAgent === "codex" ? initialAgent : null);
  const [source, setSource] = useState<SkillSource | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    skills
      .list(projectPath, refresh > 0)
      .then((found) => {
        if (!live) return;
        setRows(found);
        setError(null);
      })
      .catch((reason) => live && setError(errorMessage(reason)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [projectPath, refresh]);

  const counts = useMemo(
    () => ({
      claude: rows.filter((skill) => reaches(skill, "claude")).length,
      codex: rows.filter((skill) => reaches(skill, "codex")).length,
      both: rows.filter((skill) => reaches(skill, "both")).length,
      personal: rows.filter((skill) => skill.source === "personal").length,
      repo: rows.filter((skill) => skill.source === "repo").length,
      plugin: rows.filter((skill) => skill.source === "plugin").length,
      bundled: rows.filter((skill) => skill.source === "bundled").length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((skill) => {
      if (agent && !reaches(skill, agent)) return false;
      if (source && skill.source !== source) return false;
      return !needle || skill.name.toLocaleLowerCase().includes(needle) || skill.description.toLocaleLowerCase().includes(needle);
    });
  }, [rows, agent, source, query]);

  const selected = filtered.find((skill) => skill.dirPath === selectedPath) ?? filtered[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold">Skills</h1>
          <p className="truncate text-[11px] text-faint">
            {projectPath ? `Personal skills and ${projectPath.split("/").pop() ?? "this project"}` : "Personal skills on this Mac"}
          </p>
        </div>
        <span className="text-xs tabular-nums text-faint">{rows.length} found</span>
        <WithTooltip label="Refresh skills">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh skills" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw className={cn(loading && "animate-spin")} />
          </Button>
        </WithTooltip>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex w-[22rem] shrink-0 flex-col border-r border-hairline">
          <div className="flex flex-col gap-2 border-b border-hairline p-3">
            <label className="flex h-8 items-center gap-2 rounded-md bg-well px-2 focus-within:ring-2 focus-within:ring-ring/40">
              <Search className="size-3.5 shrink-0 text-faint" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-faint"
              />
            </label>
            <div className="flex flex-wrap gap-1.5" aria-label="Filter by agent">
              <FilterChip active={agent === "claude"} label="Claude" count={counts.claude} onClick={() => setAgent(agent === "claude" ? null : "claude")} />
              <FilterChip active={agent === "codex"} label="Codex" count={counts.codex} onClick={() => setAgent(agent === "codex" ? null : "codex")} />
              <FilterChip active={agent === "both"} label="Both" count={counts.both} onClick={() => setAgent(agent === "both" ? null : "both")} />
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Filter by source">
              {(["personal", "repo", "plugin", "bundled"] as const).map((kind) => (
                <FilterChip
                  key={kind}
                  active={source === kind}
                  label={SOURCE_LABEL[kind]}
                  count={counts[kind]}
                  onClick={() => setSource(source === kind ? null : kind)}
                />
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin py-1">
            {error && <div className="m-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
            {loading && !rows.length && (
              <div className="flex items-center gap-2 px-4 py-6 text-xs text-faint">
                <Loader2 className="size-3.5 animate-spin" /> Reading skill folders…
              </div>
            )}
            {!loading && !error && !filtered.length && (
              <div className="px-4 py-6 text-center text-xs text-faint">No skills match these filters.</div>
            )}
            {filtered.map((skill) => (
              <button
                key={skill.dirPath}
                type="button"
                onClick={() => setSelectedPath(skill.dirPath)}
                className={cn(
                  "flex w-full flex-col gap-1 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
                  selected?.dirPath === skill.dirPath ? "bg-selected" : "hover:bg-veil-raised",
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{skill.name}</span>
                  <span className="flex shrink-0 items-center gap-1 text-faint">
                    {skill.agents.map((id) => (
                      <AgentMark key={id} id={id} className="size-3.5" />
                    ))}
                  </span>
                </span>
                <span className="w-full truncate text-[11px] text-muted-foreground">{skill.description}</span>
                <span className="flex max-w-full items-center gap-1.5">
                  <span className="rounded bg-veil-raised px-1.5 py-0.5 text-[10px] text-faint">{SOURCE_LABEL[skill.source]}</span>
                  <span className="min-w-0 truncate rounded bg-veil-raised px-1.5 py-0.5 font-mono text-[10px] text-faint">{skill.sourceLabel}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <SkillReader skill={selected} />
      </div>
    </div>
  );
}

function SkillReader({ skill }: { skill: DiscoveredSkill | null }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    if (skill) {
      skills
        .detail(skill.dirPath)
        .then((value) => live && setDetail(value))
        .catch((reason) => live && setError(errorMessage(reason)));
    }
    return () => {
      live = false;
    };
  }, [skill]);

  if (!skill) {
    return <div className="flex min-w-0 flex-1 items-center justify-center text-xs text-faint">Select a skill to read it.</div>;
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-hairline px-5 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{skill.name}</h2>
              <span className="rounded bg-veil-raised px-1.5 py-0.5 text-[10px] text-faint">{SOURCE_LABEL[skill.source]}</span>
              {skill.source === "plugin" && <span className="truncate text-[11px] text-faint">{skill.sourceLabel}</span>}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{skill.description}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-faint">
              {skill.roots.map((root) => (
                <span key={root} className="font-mono">{root}</span>
              ))}
              <span className="flex items-center gap-1">
                {skill.agents.map((id) => (
                  <span key={id} className="flex items-center gap-0.5 capitalize">
                    <AgentMark id={id} className="size-3" decorative /> {id}
                  </span>
                ))}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => void revealItemInDir(skill.dirPath).catch(() => {})}>
              <FolderOpen /> Reveal in Finder
            </Button>
            <Button variant="outline" size="sm" onClick={() => void openPath(skill.skillFilePath).catch(() => {})}>
              <FileCode2 /> Open in editor
            </Button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="m-5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
      ) : !detail ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-faint">
          <Loader2 className="size-3.5 animate-spin" /> Reading SKILL.md…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto scrollbar-thin px-6 py-5">
            <Markdown text={detail.markdown} />
          </div>
          <aside className="w-56 shrink-0 overflow-y-auto border-l border-hairline p-3 scrollbar-thin">
            {detail.executableFiles.length > 0 && (
              <section className="mb-4 rounded-lg bg-warning/8 p-2.5 hairline">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-warning">Executable files</h3>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {detail.executableFiles.map((path) => (
                    <li key={path} className="break-all font-mono text-[10px] text-muted-foreground">{path}</li>
                  ))}
                </ul>
              </section>
            )}
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">Files</h3>
            <div className="flex flex-col">
              {detail.files.map((file) => {
                const depth = file.path.split("/").length - 1;
                return (
                  <div key={file.path} className="flex h-[22px] min-w-0 items-center gap-1 text-[11px] text-muted-foreground" style={{ paddingLeft: depth * 10 }} title={file.path}>
                    {file.isDir ? <ChevronDown className="size-3 shrink-0 text-faint" /> : <span className="w-3 shrink-0" />}
                    <FileTypeIcon name={file.name} isDir={file.isDir} isOpen={file.isDir} size={15} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    {file.executable && <span className="size-1.5 shrink-0 rounded-full bg-warning" title="Executable" />}
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
