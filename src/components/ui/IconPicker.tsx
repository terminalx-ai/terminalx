import { useId, useState } from "react";
import {
  Activity, BookOpen, Box, Braces, Bug, Check, Cloud, Code, Database, FileCode2,
  FlaskConical, Folder, GitBranch, Globe, Hammer, Heart, Layers, Package,
  Play, Rocket, Search, Server, Settings, Shield, Sparkles, Star, Terminal, Wrench, Zap,
} from "@/icons";
import { Button } from "./button";

// Named imports keep the picker small and use TerminalX's drawings where available.
// Stable string ids can be shared by action and repository icon settings.
const ICONS = [
  { id: "terminal", label: "Terminal", icon: Terminal, keywords: "command shell script" },
  { id: "play", label: "Play", icon: Play, keywords: "run start dev" },
  { id: "rocket", label: "Rocket", icon: Rocket, keywords: "launch deploy" },
  { id: "flask", label: "Flask", icon: FlaskConical, keywords: "test experiment" },
  { id: "check", label: "Check", icon: Check, keywords: "test lint validate" },
  { id: "bug", label: "Bug", icon: Bug, keywords: "debug test" },
  { id: "hammer", label: "Hammer", icon: Hammer, keywords: "build compile" },
  { id: "wrench", label: "Wrench", icon: Wrench, keywords: "tool repair" },
  { id: "globe", label: "Globe", icon: Globe, keywords: "web browser preview" },
  { id: "server", label: "Server", icon: Server, keywords: "backend api" },
  { id: "database", label: "Database", icon: Database, keywords: "storage sql" },
  { id: "cloud", label: "Cloud", icon: Cloud, keywords: "deploy remote" },
  { id: "folder", label: "Folder", icon: Folder, keywords: "repository project" },
  { id: "git-branch", label: "Git branch", icon: GitBranch, keywords: "repository version" },
  { id: "code", label: "Code", icon: Code, keywords: "source develop" },
  { id: "file-code", label: "Code file", icon: FileCode2, keywords: "script source" },
  { id: "braces", label: "Braces", icon: Braces, keywords: "json format" },
  { id: "package", label: "Package", icon: Package, keywords: "dependency install" },
  { id: "box", label: "Box", icon: Box, keywords: "container docker" },
  { id: "layers", label: "Layers", icon: Layers, keywords: "stack services" },
  { id: "book", label: "Book", icon: BookOpen, keywords: "docs documentation" },
  { id: "shield", label: "Shield", icon: Shield, keywords: "security audit" },
  { id: "activity", label: "Activity", icon: Activity, keywords: "monitor health" },
  { id: "settings", label: "Settings", icon: Settings, keywords: "configure setup" },
  { id: "zap", label: "Lightning", icon: Zap, keywords: "fast speed" },
  { id: "sparkles", label: "Sparkles", icon: Sparkles, keywords: "clean generate" },
  { id: "star", label: "Star", icon: Star, keywords: "favorite" },
  { id: "heart", label: "Heart", icon: Heart, keywords: "favorite" },
] as const;

/** Unknown ids from newer repository files still render without losing their value. */
export function RepositoryIcon({ value, className }: { value: string; className?: string }) {
  const Icon = ICONS.find((entry) => entry.id === value)?.icon ?? Folder;
  return <Icon aria-hidden className={className} />;
}

export function IconPicker({ value, onChange, disabled = false, label = "Icon" }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const tokens = query.trim().toLowerCase().split(/\s+/);
  const choices = ICONS.filter((entry) => tokens.every((token) => `${entry.label} ${entry.id} ${entry.keywords}`.toLowerCase().includes(token)));
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className="mb-1 text-xs font-medium">{label}</legend>
      <label htmlFor={id} className="flex items-center gap-2 rounded-md border border-border bg-well px-2">
        <Search aria-hidden className="size-3.5 text-muted-foreground" />
        <input id={id} type="search" aria-label="Search icons" placeholder="Search icons…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) event.preventDefault();
        }} className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </label>
      <div role="group" aria-label={`${label} choices`} className="flex max-h-32 flex-wrap gap-1 overflow-y-auto scrollbar-thin">
        {choices.map((entry) => (
          <Button key={entry.id} variant={value === entry.id ? "secondary" : "ghost"} size="icon" title={entry.label} aria-label={entry.label} aria-pressed={value === entry.id} onClick={() => onChange(entry.id)}>
            <entry.icon aria-hidden />
          </Button>
        ))}
        {!choices.length && <p role="status" className="py-2 text-xs text-muted-foreground">No matching icons.</p>}
      </div>
    </fieldset>
  );
}
