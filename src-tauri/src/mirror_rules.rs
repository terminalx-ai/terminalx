//! What a local mirror of a cloud workspace never holds (PRO-25,
//! docs/CLOUD-MIRROR.md). The runtime applies these when it lists the files
//! to mirror, so excluded bytes never leave the workspace, and the desktop
//! applies them again before it writes anything.
//!
//! The rules are by name, not by content: a file that looks like a
//! credential store or a private key is left out, whatever Git thinks of it.
//! They err towards leaving a file out. A repository adds its own
//! exclusions in `.terminalx-mirror-ignore` (gitignore syntax).
//!
//! Two more rules are about this computer, not about secrets. The workspace
//! is not trusted: other people's agents run there, and what it lists ends
//! up in a folder local tools read. So a mirror never holds
//!
//! - **anything that is a Git directory** ([`git_directories`],
//!   [`git_pointer`]): a folder with `HEAD` and any other piece of one, under
//!   any name. Git run inside it would obey its `config`, which can name a
//!   command to execute;
//! - **tool configuration that runs things by itself** ([`tool_config`]):
//!   agent settings and hooks, MCP servers, editor tasks, Git hooks, other
//!   version-control systems' own folders.
//!
//! Names are compared the way a disk that folds them does ([`fold`]): case
//! by Unicode's rules (the long s `ſ` is `s`, the Kelvin sign is `k`), and
//! composed or decomposed forms alike. That is this module's best knowledge
//! of the disk; the desktop also looks at what really landed on it after
//! every publish, so the filesystem has the last word.

/// A repository's own exclusions, at its root.
pub const IGNORE_FILE: &str = ".terminalx-mirror-ignore";

/// Directories whose contents are credentials or keys.
const SECRET_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".azure", ".gcloud", ".docker"];
/// Directory pairs: the GitHub CLI keeps its tokens in `.config/gh`.
const SECRET_DIR_PAIRS: &[(&str, &str)] = &[(".config", "gh"), (".config", "gcloud")];
/// Tool configuration that executes without being asked: agent settings and
/// hooks, MCP servers, editor tasks and run configurations, Git hooks,
/// container definitions an editor offers to start.
const TOOL_CONFIG_DIRS: &[&str] = &[
    // Agents.
    ".claude", ".codex", ".cursor", ".gemini", ".windsurf", ".continue", ".roo", ".kiro", ".amazonq",
    // Editors and their run configurations.
    ".vscode", ".idea", ".zed", ".helix", ".run", ".devcontainer",
    // Hooks and shells.
    ".husky", ".githooks", ".direnv",
    // Other version-control systems: their tools obey these as Git obeys `.git`.
    ".hg", ".jj", ".sl", ".svn",
    // Build tools that load code or settings from here.
    ".mvn",
];
const TOOL_CONFIG_NAMES: &[&str] = &[
    ".mcp.json",
    ".envrc",
    ".cursorrules",
    ".pre-commit-config.yaml",
    ".lefthook.yml",
    "lefthook.yml",
    ".yarnrc.yml",
    ".yarnrc",
    "bunfig.toml",
    ".pnpmfile.cjs",
    ".nvim.lua",
    ".exrc",
    "mise.toml",
    ".mise.toml",
    "opencode.json",
    ".aider.conf.yml",
];
/// `<dir>/<name>` pairs: Cargo runs what its config names; the Gradle
/// wrapper downloads and runs what its properties name.
const TOOL_CONFIG_PAIRS: &[(&str, &str)] = &[(".cargo", "config.toml"), (".cargo", "config"), ("wrapper", "gradle-wrapper.properties")];
/// Extensions of files an editor opens as a project of its own.
const TOOL_CONFIG_EXTENSIONS: &[&str] = &["code-workspace"];
/// Besides `HEAD`, any one of these makes a folder a Git directory: Git
/// accepts one split in two (`commondir`), and reads `config.worktree`.
const GIT_DIRECTORY_FOLDERS: &[&str] = &["objects", "refs"];
const GIT_DIRECTORY_FILES: &[&str] = &["commondir", "gitdir", "config", "config.worktree"];
/// Files that point Git at a directory elsewhere: refused wherever they are.
const GIT_POINTERS: &[&str] = &["commondir", "gitdir"];

/// A name as a disk that folds case and Unicode form compares it: composed,
/// case-folded by Unicode's rules (upper, then lower, so the long s is `s`
/// and the Kelvin sign `k`), composed again.
pub fn fold(name: &str) -> String {
    let nfc = icu_normalizer::ComposingNormalizerBorrowed::new_nfc();
    let folded: String = nfc.normalize(name).chars().flat_map(char::to_uppercase).flat_map(char::to_lowercase).collect();
    nfc.normalize(&folded).into_owned()
}

fn folded_parts(path: &str) -> Vec<String> {
    path.split('/').filter(|part| !part.is_empty()).map(fold).collect()
}
/// File names that hold credentials.
const SECRET_NAMES: &[&str] = &[
    ".npmrc",
    ".netrc",
    "_netrc",
    ".pypirc",
    ".git-credentials",
    ".htpasswd",
    ".dockercfg",
    "credentials",
    "credentials.json",
    ".credentials.json",
    ".terraformrc",
    "terraform.rc",
    "service-account.json",
    "secrets.json",
    "secrets.yml",
    "secrets.yaml",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];
/// Extensions of key and credential stores.
const SECRET_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "tfstate", "tfvars"];
/// `.env.<this>` is a template, not a secret.
const ENV_TEMPLATES: &[&str] = &["example", "sample", "template", "dist", "defaults"];

/// A file a mirror never holds, by its workspace-relative path.
pub fn secret(path: &str) -> bool {
    let mut parts = folded_parts(path);
    let Some(name) = parts.pop() else { return false };
    if parts.iter().any(|dir| SECRET_DIRS.contains(&dir.as_str())) {
        return true;
    }
    if parts.windows(2).any(|pair| SECRET_DIR_PAIRS.contains(&(pair[0].as_str(), pair[1].as_str()))) {
        return true;
    }
    // Agent logins, wherever the agent's folder is.
    if name == "auth.json" && parts.last().is_some_and(|dir| dir == ".codex") {
        return true;
    }
    if SECRET_NAMES.contains(&name.as_str()) {
        return true;
    }
    if name == ".env" || name == ".envrc" {
        return true;
    }
    if let Some(rest) = name.strip_prefix(".env.") {
        return !ENV_TEMPLATES.contains(&rest);
    }
    // `backup.tfstate.1`, `prod.key.bak`: any extension counts, not only the last.
    name.split('.').skip(1).any(|extension| SECRET_EXTENSIONS.contains(&extension))
}

/// Tool configuration that runs commands by itself: never part of the file
/// set, because a local editor, shell or agent opened in the mirror would
/// obey it.
pub fn tool_config(path: &str) -> bool {
    let mut parts = folded_parts(path);
    let Some(name) = parts.pop() else { return false };
    parts.iter().any(|dir| TOOL_CONFIG_DIRS.contains(&dir.as_str()))
        || TOOL_CONFIG_NAMES.contains(&name.as_str())
        || parts.last().is_some_and(|dir| TOOL_CONFIG_PAIRS.contains(&(dir.as_str(), name.as_str())))
        || name.rsplit_once('.').is_some_and(|(_, extension)| TOOL_CONFIG_EXTENSIONS.contains(&extension))
}

/// A file that points Git at a directory elsewhere (`commondir`, `gitdir`).
/// With one, a folder holding only `HEAD` is a repository whose objects and
/// config live in another folder.
pub fn git_pointer(path: &str) -> bool {
    folded_parts(path).last().is_some_and(|name| GIT_POINTERS.contains(&name.as_str()))
}

/// The directories among `paths` that Git would take for a repository's own
/// directory, whatever they are called (`""` is the root): one holding
/// `HEAD` and any other piece of a Git directory (`objects/`, `refs/`,
/// `commondir`, `gitdir`, `config`, `config.worktree`). Everything under one
/// is left out. Returned folded ([`fold`]): `pkg`, `PKG` and `Pkg` are one
/// folder on the disk the mirror lands on.
pub fn git_directories<'a>(paths: impl IntoIterator<Item = &'a str>) -> std::collections::BTreeSet<String> {
    use std::collections::BTreeMap;
    // Per folded directory: has HEAD, has another piece.
    let mut seen: BTreeMap<String, [bool; 2]> = BTreeMap::new();
    for path in paths {
        let parts = folded_parts(path);
        for (index, part) in parts.iter().enumerate() {
            let last = index + 1 == parts.len();
            let slot = match (part.as_str(), last) {
                ("head", true) => 0,
                (name, false) if GIT_DIRECTORY_FOLDERS.contains(&name) => 1,
                (name, true) if GIT_DIRECTORY_FILES.contains(&name) => 1,
                _ => continue,
            };
            seen.entry(parts[..index].join("/")).or_default()[slot] = true;
        }
    }
    seen.into_iter().filter(|(_, marks)| marks.iter().all(|mark| *mark)).map(|(dir, _)| dir).collect()
}

/// Is `path` inside one of `directories` (as [`git_directories`] returns them)?
pub fn inside(path: &str, directories: &std::collections::BTreeSet<String>) -> bool {
    if directories.is_empty() {
        return false;
    }
    let path = folded_parts(path).join("/");
    directories.iter().any(|dir| dir.is_empty() || path.len() > dir.len() && path.as_bytes()[dir.len()] == b'/' && path.starts_with(dir.as_str()))
}

/// Git's own metadata and the mirror's: never part of the file set.
pub fn reserved(path: &str) -> bool {
    path.split('/').any(|part| fold(part) == ".git")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_and_keys_are_secret_by_name() {
        for path in [
            ".env",
            "app/.env",
            ".env.local",
            ".env.production",
            ".envrc",
            "deploy/prod.pem",
            "server.key",
            "certs/client.P12",
            "id_rsa",
            "keys/id_ed25519",
            ".npmrc",
            "home/.netrc",
            ".git-credentials",
            ".aws/credentials",
            "infra/.ssh/config",
            "terraform.tfstate",
            "terraform.tfstate.backup",
            "prod.tfvars",
            "secrets.yaml",
            "vault.kdbx",
            "config/credentials.json",
        ] {
            assert!(secret(path), "{path}");
        }
    }

    #[test]
    fn ordinary_files_and_env_templates_are_not() {
        for path in [
            "README.md",
            "src/main.rs",
            ".env.example",
            ".env.sample",
            "docs/keys.md",
            "id_rsa.pub",
            "src/environment.ts",
            "keyboard.key.ts.md5",
            "package.json",
            ".gitignore",
            "src/secrets.rs",
            "public/pemberton.txt",
        ] {
            // `keyboard.key.ts.md5` has a `key` extension in the middle: left out on purpose.
            assert_eq!(secret(path), path == "keyboard.key.ts.md5", "{path}");
        }
    }

    #[test]
    fn agent_logins_and_cli_tokens_are_secret() {
        for path in [".claude/.credentials.json", "home/.codex/auth.json", ".config/gh/hosts.yml", ".config/gh/config.yml", ".terraformrc", "terraform.rc"] {
            assert!(secret(path), "{path}");
        }
        assert!(!secret("src/auth.json"));
        assert!(!secret("config/gh.yml"));
    }

    #[test]
    fn tool_configuration_that_runs_by_itself_is_named() {
        for path in [
            ".claude/settings.json",
            ".claude/settings.local.json",
            "packages/app/.claude/hooks/pre.sh",
            ".mcp.json",
            "sub/.mcp.json",
            ".codex/config.toml",
            ".cursor/mcp.json",
            ".vscode/tasks.json",
            ".vscode/settings.json",
            ".idea/workspace.xml",
            ".cargo/config.toml",
            "crates/x/.cargo/config",
            ".envrc",
            ".husky/pre-commit",
            ".githooks/pre-push",
            ".devcontainer/devcontainer.json",
            ".pre-commit-config.yaml",
            ".VSCode/tasks.json",
        ] {
            assert!(tool_config(path), "{path}");
        }
        for path in ["README.md", "src/claude.ts", "docs/vscode.md", "Cargo.toml", ".cargo-ok", "cargo/config.toml", "mcp.json", "package.json", "Makefile", "CLAUDE.md"] {
            assert!(!tool_config(path), "{path}");
        }
    }

    #[test]
    fn a_git_directory_is_found_under_any_name() {
        let found = |paths: &[&str]| git_directories(paths.iter().copied()).into_iter().collect::<Vec<_>>();
        // The first reproduced attack: a bare repository committed as ordinary files.
        assert_eq!(found(&["pkg/HEAD", "pkg/config", "pkg/objects/x", "pkg/refs/x", "pkg/README", "src/a.ts"]), ["pkg"]);
        // Case does not hide it, and the answer is folded.
        assert_eq!(found(&["a/b/head", "a/b/Objects/pack/p", "a/b/REFS/heads/main"]), ["a/b"]);
        // At the root, and nested.
        assert_eq!(found(&["HEAD", "objects/1", "refs/2"]), [""]);
        assert_eq!(found(&["x/HEAD", "x/objects/1", "x/y/HEAD", "x/y/refs/2"]), ["x", "x/y"]);
        // Not one: no HEAD, or HEAD with nothing of a Git directory beside it.
        assert!(found(&["docs/refs/x", "docs/objects/a.o", "docs/config"]).is_empty());
        assert!(found(&["docs/HEAD", "docs/README.md", "docs/objects.md"]).is_empty());
        assert!(found(&["src/head.ts", "src/objects/a.ts", "src/refs/b.ts"]).is_empty());

        let dirs = git_directories(["pkg/HEAD", "pkg/objects/x"]);
        assert!(inside("pkg/config", &dirs) && inside("PKG/objects/x", &dirs));
        assert!(!inside("pkg2/config", &dirs) && !inside("pkg", &dirs) && !inside("src/pkg/HEAD", &dirs));
        assert!(inside("anything", &git_directories(["HEAD", "objects/1"])));
    }

    #[test]
    fn a_git_directory_split_across_two_folders_is_found() {
        // Second reproduced attack: one folder holds HEAD and a `commondir`
        // file pointing at a sibling that holds objects and refs. Neither
        // folder has all three, and Git still takes the first for a repository.
        let paths = ["wt/HEAD", "wt/commondir", "wt/config.worktree", "common/objects/x", "common/refs/x", "common/config"];
        assert_eq!(git_directories(paths).into_iter().collect::<Vec<_>>(), ["wt"]);
        // And the pointer is refused wherever it is, so the pair cannot be completed.
        assert!(git_pointer("wt/commondir") && git_pointer("any/where/gitdir") && git_pointer("x/COMMONDIR"));
        assert!(!git_pointer("docs/commondir.md") && !git_pointer("src/gitdir/a.ts"));
        // HEAD with any single piece is enough.
        for piece in ["d/objects/x", "d/refs/x", "d/commondir", "d/gitdir", "d/config", "d/config.worktree"] {
            assert_eq!(git_directories(["d/HEAD", piece]).len(), 1, "{piece}");
        }
    }

    #[test]
    fn names_the_disk_folds_are_folded_here_too() {
        // Third and fourth: the long s (U+017F) is `s` and the Kelvin sign
        // (U+212A) is `k` on APFS; ASCII lower-casing knew neither.
        assert_eq!(fold("objectſ"), "objects");
        assert_eq!(fold("\u{212a}elvin"), "kelvin");
        assert_eq!(fold("STRASSE"), fold("straße"));
        assert_eq!(fold("ΣΑΣ"), fold("σας"));
        assert_eq!(fold("cafe\u{301}"), fold("caf\u{e9}"));
        assert_eq!(git_directories(["pkg/HEAD", "pkg/objectſ/x", "pkg/refſ/x"]).into_iter().collect::<Vec<_>>(), ["pkg"]);
        for path in [".vſcode/taſkſ.json", ".mcp.jſon", ".huſky/pre-commit", ".hus\u{212a}y/pre-commit", ".curſor/mcp.json", ".CLAUDE/settings.json"] {
            assert!(tool_config(path), "{path}");
        }
        for path in [".ſsh/id_ed25519", ".aws/credentialſ", ".ENV", "prod.\u{212a}EY"] {
            assert!(secret(path), "{path}");
        }
        assert!(reserved("sub/.GIT/config") && reserved(".git/HEAD"));
        // One folder under three spellings is one folder.
        let dirs = git_directories(["pkg/HEAD", "PKG/objects/x", "Pkg/refs/x"]);
        assert_eq!(dirs.iter().collect::<Vec<_>>(), ["pkg"]);
        assert!(inside("PKG/objects/x", &dirs) && inside("Pkg/refs/x", &dirs) && inside("pkg/HEAD", &dirs));
    }

    #[test]
    fn more_tools_that_run_what_a_folder_tells_them() {
        for path in [
            ".hg/hgrc",
            ".jj/repo/config.toml",
            ".sl/config",
            ".svn/entries",
            ".yarnrc.yml",
            ".yarnrc",
            "bunfig.toml",
            ".pnpmfile.cjs",
            ".mvn/extensions.xml",
            "gradle/wrapper/gradle-wrapper.properties",
            ".helix/config.toml",
            ".nvim.lua",
            ".exrc",
            "app.code-workspace",
            ".run/Debug.run.xml",
            "mise.toml",
            "opencode.json",
            ".windsurf/rules.md",
            ".continue/config.json",
            ".aider.conf.yml",
            ".roo/mcp.json",
            ".kiro/settings.json",
            ".amazonq/mcp.json",
        ] {
            assert!(tool_config(path), "{path}");
        }
        for path in ["gradle/wrapper/gradle-wrapper.jar", "docs/yarnrc.md", "src/run/a.ts", "workspace.code-workspace.md"] {
            assert!(!tool_config(path), "{path}");
        }
    }

    #[test]
    fn git_metadata_is_reserved() {
        assert!(reserved(".git/config"));
        assert!(reserved("packages/app/.git/HEAD"));
        assert!(reserved("sub/.GIT/hooks/pre-commit"));
        assert!(!reserved(".github/workflows/ci.yml"));
        assert!(!reserved(".gitignore"));
    }
}
