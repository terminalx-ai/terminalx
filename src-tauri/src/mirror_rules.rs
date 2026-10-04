//! What a local mirror of a cloud workspace never holds (PRO-25,
//! docs/CLOUD-MIRROR.md). The runtime applies these when it lists the files
//! to mirror, so excluded bytes never leave the workspace, and the desktop
//! applies them again before it writes anything.
//!
//! The rules are by name, not by content: a file that looks like a
//! credential store or a private key is left out, whatever Git thinks of it.
//! They err towards leaving a file out. A repository adds its own
//! exclusions in `.terminalx-mirror-ignore` (gitignore syntax).

/// A repository's own exclusions, at its root.
pub const IGNORE_FILE: &str = ".terminalx-mirror-ignore";

/// Directories whose contents are credentials or keys.
const SECRET_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".azure", ".gcloud", ".docker"];
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
    fn git_metadata_is_reserved() {
        assert!(reserved(".git/config"));
        assert!(reserved("packages/app/.git/HEAD"));
        assert!(reserved("sub/.GIT/hooks/pre-commit"));
        assert!(!reserved(".github/workflows/ci.yml"));
        assert!(!reserved(".gitignore"));
    }
}
