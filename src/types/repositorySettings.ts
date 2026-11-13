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
  patterns: { pattern: string; matches: string[]; omitted?: number; error: string | null; /** Why a valid pattern matched nothing; null when it matched. */ reason?: string | null }[];
}

export interface WorktreeCopyReport {
  copiedCount: number;
  copiedBytes: number;
  /** First copied path, for the 'Copied … and N other files' step. */
  firstCopied?: string | null;
  skippedCount: number;
  warnings: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
  error: string | null;
}
