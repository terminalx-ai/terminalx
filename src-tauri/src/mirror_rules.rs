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
//! - **anything that is a Git directory** ([`git_directories`]): a folder
//!   with `HEAD`, `objects/` and `refs/` under any name. Git run inside it
//!   would obey its `config`, which can name a command to execute;
//! - **tool configuration that runs things by itself** ([`tool_config`]):
//!   agent settings and hooks, MCP servers, editor tasks, Git hooks.

/// A repository's own exclusions, at its root.
pub const IGNORE_FILE: &str = ".terminalx-mirror-ignore";

/// Directories whose contents are credentials or keys.
const SECRET_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".azure", ".gcloud", ".docker"];
/// Directory pairs: the GitHub CLI keeps its tokens in `.config/gh`.
const SECRET_DIR_PAIRS: &[(&str, &str)] = &[(".config", "gh"), (".config", "gcloud")];
/// Tool configuration that executes without being asked: agent settings and
/// hooks, MCP servers, editor tasks and run configurations, Git hooks,
/// container definitions an editor offers to start.
const TOOL_CONFIG_DIRS: &[&str] = &[".claude", ".codex", ".cursor", ".gemini", ".vscode", ".idea", ".zed", ".husky", ".githooks", ".devcontainer", ".direnv"];
const TOOL_CONFIG_NAMES: &[&str] = &[".mcp.json", ".envrc", ".cursorrules", ".pre-commit-config.yaml", ".lefthook.yml", "lefthook.yml"];
/// `<dir>/<name>` pairs: Cargo runs what its config names.
const TOOL_CONFIG_PAIRS: &[(&str, &str)] = &[(".cargo", "config.toml"), (".cargo", "config")];
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
    let mut parts: Vec<String> = path.split('/').filter(|part| !part.is_empty()).map(str::to_ascii_lowercase).collect();
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
    let mut parts: Vec<String> = path.split('/').filter(|part| !part.is_empty()).map(str::to_ascii_lowercase).collect();
    let Some(name) = parts.pop() else { return false };
    parts.iter().any(|dir| TOOL_CONFIG_DIRS.contains(&dir.as_str()))
        || TOOL_CONFIG_NAMES.contains(&name.as_str())
        || parts.last().is_some_and(|dir| TOOL_CONFIG_PAIRS.contains(&(dir.as_str(), name.as_str())))
}

/// The directories among `paths` that Git would take for a repository's own
/// directory: one holding `HEAD` and something under `objects/` and `refs/`,
/// whatever it is called (`""` is the root). Everything under one is left
/// out. Names are compared without case: the mirror may land on a disk that
/// folds it.
pub fn git_directories<'a>(paths: impl IntoIterator<Item = &'a str>) -> std::collections::BTreeSet<String> {
    use std::collections::{BTreeMap, BTreeSet};
    // Per directory: has HEAD, has objects/, has refs/.
    let mut seen: BTreeMap<String, [bool; 3]> = BTreeMap::new();
    for path in paths {
        let parts: Vec<&str> = path.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            let dir = parts[..index].join("/");
            let last = index + 1 == parts.len();
            let slot = match (part.to_ascii_lowercase().as_str(), last) {
                ("head", true) => 0,
                ("objects", false) => 1,
                ("refs", false) => 2,
                _ => continue,
            };
            seen.entry(dir).or_default()[slot] = true;
        }
    }
    seen.into_iter().filter(|(_, marks)| marks.iter().all(|mark| *mark)).map(|(dir, _)| dir).collect::<BTreeSet<_>>()
}

/// Is `path` inside one of `directories` (as [`git_directories`] returns them)?
pub fn inside(path: &str, directories: &std::collections::BTreeSet<String>) -> bool {
    directories.iter().any(|dir| dir.is_empty() || path.len() > dir.len() && path.as_bytes()[dir.len()] == b'/' && path.starts_with(dir.as_str()))
}

/// Git's own metadata and the mirror's: never part of the file set.
pub fn reserved(path: &str) -> bool {
    path.split('/').any(|part| part.eq_ignore_ascii_case(".git"))
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
        // The reproduced attack: a bare repository committed as ordinary files.
        assert_eq!(found(&["pkg/HEAD", "pkg/config", "pkg/objects/x", "pkg/refs/x", "pkg/README", "src/a.ts"]), ["pkg"]);
        // No config is needed for Git to take it, and case does not hide it.
        assert_eq!(found(&["a/b/head", "a/b/Objects/pack/p", "a/b/REFS/heads/main"]), ["a/b"]);
        // At the root, and nested.
        assert_eq!(found(&["HEAD", "objects/1", "refs/2"]), [""]);
        assert_eq!(found(&["x/HEAD", "x/objects/1", "x/refs/2", "x/y/HEAD", "x/y/objects/1", "x/y/refs/2"]), ["x", "x/y"]);
        // Not one: a file called objects, or only two of the three.
        assert!(found(&["pkg/HEAD", "pkg/objects", "pkg/refs/x"]).is_empty());
        assert!(found(&["docs/HEAD", "docs/refs/x", "src/objects/a.o"]).is_empty());
        assert!(found(&["src/head.ts", "src/objects/a.ts", "src/refs/b.ts"]).is_empty());

        let dirs = git_directories(["pkg/HEAD", "pkg/objects/x", "pkg/refs/x"]);
        assert!(inside("pkg/config", &dirs) && inside("pkg/objects/x", &dirs));
        assert!(!inside("pkg2/config", &dirs) && !inside("pkg", &dirs) && !inside("src/pkg/HEAD", &dirs));
        assert!(inside("anything", &git_directories(["HEAD", "objects/1", "refs/2"])));
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
