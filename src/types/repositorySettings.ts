/** Local choices; repository files are resolved by Rust without overwriting this layer. */
export interface RepositorySettings {
  filesToCopy: string[];
}

export interface RepositoryFilesPreview {
  rootPath: string;
  workspacesPath: string;
  fromIncludeFile: boolean;
  error?: string | null;
  patterns: { pattern: string; matches: string[]; error: string | null }[];
}

export interface WorktreeCopyReport {
  copied: string[];
  skipped: { path: string; reason: string }[];
  error: string | null;
}
