/** Local choices; repository files are resolved by Rust without overwriting this layer. */
export interface RepositorySettings {
  filesToCopy: string[];
}

export interface RepositoryFilesPreview {
  rootPath: string;
  workspacesPath: string;
  fromIncludeFile: boolean;
  error?: string | null;
  warning?: string | null;
  patterns: { pattern: string; matches: string[]; omitted?: number; error: string | null }[];
}

export interface WorktreeCopyReport {
  copiedCount: number;
  copiedBytes: number;
  skippedCount: number;
  warnings: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  error: string | null;
}
