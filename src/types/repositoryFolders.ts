/** The repository's folders as `repository_folders` lists them, for choosing a
 * sparse checkout (Settings → project → General → Check out only some folders).
 * Paths are relative to the repository root, `/`-separated, with no leading or
 * trailing slash. Sizes are bytes of the files tracked at HEAD, which is what a
 * new workspace checks out; `null` while not measured or when they cannot be read. */
export interface RepositoryFolder {
  path: string;
  /** From the folder's own package.json or Cargo.toml description, or its README's first line. */
  description: string | null;
  size: number | null;
  /** Folders one level down, listed where a top-level folder has from 2 to 200 of them. Empty otherwise,
   * so a folder with more is chosen whole and a partial choice never drops subfolders the dialog did not show. */
  children: RepositoryFolder[];
}

export interface RepositoryFolders {
  folders: RepositoryFolder[];
  /** Files directly at the root: always checked out. */
  rootFiles: { count: number; size: number | null };
  /** Every tracked file at HEAD. */
  totalSize: number | null;
  /** Why sizes could not be measured, when they were asked for and could not be. */
  sizesError: string | null;
}

/** The value of the `sparseCheckout` key in the repository's shared settings
 * file (`.terminalx/settings.json`): the chosen folders, or absent for a full checkout. */
export type SparseCheckout = string[] | null;
