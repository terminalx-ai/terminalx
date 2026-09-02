export type SkillSource = "personal" | "repo" | "plugin" | "bundled";

export interface DiscoveredSkill {
  name: string;
  description: string;
  dirPath: string;
  skillFilePath: string;
  source: SkillSource;
  sourceLabel: string;
  roots: string[];
  agents: string[];
  installId?: string;
  updatedAt: string;
  hasExecutables: boolean;
}

export interface SkillFile {
  path: string;
  name: string;
  isDir: boolean;
  executable: boolean;
}

export interface SkillDetail {
  markdown: string;
  files: SkillFile[];
  executableFiles: string[];
}

export interface BundledSkillInstall {
  canonicalPath: string;
  placements: Array<{
    agent: string;
    path: string;
    outcome: "installed" | "alreadyInstalled" | "keptLocal";
  }>;
}
