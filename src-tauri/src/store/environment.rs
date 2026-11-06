//! Local environment overrides. The index contains names and opaque revisions,
//! never values (nor hashes of values). Each revision is one Keychain item.
//! A transaction switches the index only after the new item is safely stored.
//! No repository file is evaluated or trusted implicitly.
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::keychain::{Keychain, SecretStore};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.terminalx.environment";
const USER: &str = "user";
pub const MAX_BYTES: usize = 1024 * 1024;
type Values = BTreeMap<String, String>;
type Index = BTreeMap<String, Scope>;

#[derive(Clone, Default, Serialize, Deserialize)]
struct Scope {
    names: BTreeSet<String>,
    revision: String,
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stamp {
    repository: Option<String>,
    user: String,
    repo: String,
}

// Deliberately no Debug/Serialize: resolved values must never enter diagnostics.
pub struct Launch {
    pub values: Values,
    pub stamp: Stamp,
}

impl Launch {
    pub fn inject(&self, command: &mut portable_pty::CommandBuilder) {
        for (name, value) in &self.values {
            command.env(name, value);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    name: String,
    scope: &'static str,
    overridden: bool,
}

#[derive(Deserialize)]
pub struct Input {
    pub name: String,
    pub value: String,
}

pub fn validate_name(name: &str) -> Result<()> {
    let mut bytes = name.bytes();
    ensure!(
        name.len() <= 128
            && matches!(bytes.next(), Some(b'A'..=b'Z' | b'_'))
            && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
        "Use a name matching [A-Z_][A-Z0-9_]* (at most 128 characters)."
    );
    ensure!(
        !name.starts_with("TERMINALX_")
            && !name.starts_with("RACCOON_")
            && !matches!(
                name,
                "TERMINALX"
                    | "RACCOON"
                    | "TERM"
                    | "COLORTERM"
                    | "TERM_PROGRAM"
                    | "PATH"
                    | "CODEX_HOME"
                    | "CLAUDECODE"
                    | "CLAUDE_CODE_SESSION_ID"
                    | "CLAUDE_CODE_CHILD_SESSION"
                    | "CLAUDE_CODE_BRIDGE_SESSION_ID"
            ),
        "This name is reserved by TerminalX."
    );
    Ok(())
}

fn validate_values(values: &Values) -> Result<()> {
    ensure!(
        values.len() <= 256,
        "A scope can hold at most 256 variables."
    );
    ensure!(
        values.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() <= MAX_BYTES,
        "Environment values are too large."
    );
    for (name, value) in values {
        validate_name(name)?;
        ensure!(
            !value.contains('\0') && value.len() <= 64 * 1024,
            "Values must contain no NUL and be at most 64 KiB."
        );
    }
    Ok(())
}

/// All worktrees and subdirectories of a repository share its Git common dir.
/// Git's inherited discovery overrides must not redirect this lookup elsewhere.
fn repository(cwd: &Path) -> Option<String> {
    let git = crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git"));
    let output = std::process::Command::new(git)
        .current_dir(cwd)
        .env("PATH", crate::binpath::login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    Some(format!(
        "repository:{}",
        path.canonicalize().ok()?.to_str()?
    ))
}

fn scope_key(project: Option<&str>) -> Result<String> {
    match project {
        None => Ok(USER.into()),
        Some(path) => repository(Path::new(path)).context("Choose a local Git repository."),
    }
}

struct Store<'a> {
    root: PathBuf,
    secrets: &'a dyn SecretStore,
}

impl Store<'_> {
    fn index(&self) -> Result<Index> {
        // Do not propagate parser errors: a hand-edited file might contain a value.
        super::read_json(&self.root.join("environment.json"))
            .map(|v| v.unwrap_or_default())
            .map_err(|_| anyhow::anyhow!("Could not read the environment index."))
    }

    fn transaction<T>(&self, run: impl FnOnce() -> Result<T>) -> Result<T> {
        super::transaction::run(
            &self.root.join("environment.lock"),
            Duration::from_secs(10),
            run,
        )
    }

    fn values(&self, scope: Option<&Scope>) -> Result<Values> {
        let Some(scope) = scope else {
            return Ok(Values::new());
        };
        if scope.names.is_empty() {
            return Ok(Values::new());
        }
        let bytes = self.secrets.get(SERVICE, &scope.revision)
            .map_err(|_| anyhow::anyhow!("Could not read environment values from Keychain."))?
            .context("Environment values are missing from Keychain. Restore the Keychain item before launching.")?;
        let values: Values = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("Invalid environment values in Keychain."))?;
        ensure!(
            values.keys().cloned().collect::<BTreeSet<_>>() == scope.names,
            "Environment index and Keychain disagree."
        );
        validate_values(&values)?;
        Ok(values)
    }

    fn change(&self, key: &str, update: impl FnOnce(&mut Values) -> Result<()>) -> Result<()> {
        self.transaction(|| {
            let mut index = self.index()?;
            let old = index.get(key).cloned();
            let mut values = self.values(old.as_ref())?;
            update(&mut values)?;
            validate_values(&values)?;
            let scope = Scope {
                names: values.keys().cloned().collect(),
                revision: uuid::Uuid::new_v4().to_string(),
            };
            if !values.is_empty() {
                let bytes = serde_json::to_vec(&values)?;
                self.secrets
                    .set(SERVICE, &scope.revision, &bytes)
                    .map_err(|_| {
                        anyhow::anyhow!(
                            "Could not save environment values to Keychain. Nothing changed."
                        )
                    })?;
            }
            index.insert(key.into(), scope.clone());
            if super::write_json(&self.root.join("environment.json"), &index).is_err() {
                let _ = self.secrets.delete(SERVICE, &scope.revision);
                bail!("Could not save the environment index. Nothing changed.");
            }
            // An unreferenced item after a Keychain deletion failure contains no
            // discoverable value in files and can never be injected again.
            if let Some(old) = old {
                let _ = self.secrets.delete(SERVICE, &old.revision);
            }
            Ok(())
        })
    }

    fn save(&self, key: &str, inputs: Vec<Input>, previous: Option<&str>) -> Result<()> {
        ensure!(!inputs.is_empty(), "Add at least one variable.");
        ensure!(
            previous.is_none() || inputs.len() == 1,
            "Edit one variable at a time."
        );
        self.change(key, |values| {
            if let Some(previous) = previous {
                ensure!(
                    values.remove(previous).is_some(),
                    "Variable no longer exists."
                );
            }
            for Input { name, value } in inputs {
                validate_name(&name)?;
                ensure!(
                    !values.contains_key(&name),
                    "A variable with this name already exists in this scope."
                );
                values.insert(name, value);
            }
            Ok(())
        })
    }

    fn resolve(&self, repository: Option<String>) -> Result<Launch> {
        self.transaction(|| {
            let index = self.index()?;
            let mut values = self.values(index.get(USER))?;
            if let Some(key) = &repository {
                values.extend(self.values(index.get(key))?);
            }
            Ok(Launch {
                values,
                stamp: stamp(&index, repository),
            })
        })
    }
}

fn store() -> Result<Store<'static>> {
    Ok(Store {
        root: super::root()?,
        secrets: &Keychain,
    })
}
fn stamp(index: &Index, repository: Option<String>) -> Stamp {
    Stamp {
        user: index
            .get(USER)
            .map(|s| s.revision.clone())
            .unwrap_or_default(),
        repo: repository
            .as_ref()
            .and_then(|key| index.get(key))
            .map(|s| s.revision.clone())
            .unwrap_or_default(),
        repository,
    }
}

impl Stamp {
    /// A pane handed over by a runtime predating environment overrides never
    /// received any. Keep its repository identity so later edits still warn.
    pub fn unconfigured(cwd: &str) -> Self {
        Self {
            repository: repository(Path::new(cwd)),
            ..Self::default()
        }
    }

    pub fn changed(&self) -> Result<bool> {
        Ok(*self != stamp(&store()?.index()?, self.repository.clone()))
    }
}

#[cfg(not(test))]
pub fn launch(cwd: &str) -> Result<Launch> {
    let store = store()?;
    // Retain repository identity even before its first variable is added, so
    // that addition marks existing panes stale. Cloud runtimes have their own
    // environment service and no local repository scope.
    let repo = if cfg!(target_os = "macos") {
        repository(Path::new(cwd))
    } else {
        None
    };
    store.resolve(repo)
}

// PTY fixtures must never read the developer's saved names or depend on the
// process-wide TempHome used concurrently by unrelated store tests. Injection
// tests install a resolved in-memory fixture for exactly one launch.
#[cfg(test)]
thread_local! {
    static TEST_LAUNCH: std::cell::RefCell<Option<Launch>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub fn launch(_cwd: &str) -> Result<Launch> {
    Ok(TEST_LAUNCH
        .with(|slot| slot.borrow_mut().take())
        .unwrap_or_else(|| Launch {
            values: Values::new(),
            stamp: Stamp::default(),
        }))
}

pub fn list(project: Option<&str>) -> Result<Vec<Row>> {
    let key = scope_key(project)?;
    let index = store()?.index()?;
    let own = index.get(&key);
    let mut rows = Vec::new();
    if key != USER {
        if let Some(user) = index.get(USER) {
            rows.extend(user.names.iter().map(|name| Row {
                name: name.clone(),
                scope: "user",
                overridden: own.is_some_and(|s| s.names.contains(name)),
            }));
        }
    }
    if let Some(own) = own {
        rows.extend(own.names.iter().map(|name| Row {
            name: name.clone(),
            scope: if key == USER { "user" } else { "repository" },
            overridden: false,
        }));
    }
    Ok(rows)
}

pub fn reveal(project: Option<&str>, name: &str) -> Result<String> {
    validate_name(name)?;
    let key = scope_key(project)?;
    let store = store()?;
    store.transaction(|| {
        store
            .values(store.index()?.get(&key))?
            .remove(name)
            .context("Variable no longer exists.")
    })
}

pub fn save(project: Option<&str>, inputs: Vec<Input>, previous: Option<&str>) -> Result<()> {
    store()?.save(&scope_key(project)?, inputs, previous)
}

pub fn delete(project: Option<&str>, name: &str) -> Result<()> {
    validate_name(name)?;
    store()?.change(&scope_key(project)?, |values| {
        ensure!(values.remove(name).is_some(), "Variable no longer exists.");
        Ok(())
    })
}

pub fn read_env_file(project: &str, path: &str) -> Result<String> {
    scope_key(Some(project))?;
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| anyhow::anyhow!("Could not open the .env file."))?;
    ensure!(file.metadata()?.is_file(), "Choose a regular .env file.");
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Could not read the .env file."))?;
    ensure!(
        bytes.len() <= MAX_BYTES,
        "The .env file must be at most 1 MiB."
    );
    String::from_utf8(bytes).map_err(|_| anyhow::anyhow!("The .env file must be UTF-8 text."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::testing::MemorySecrets;

    fn add(store: &Store<'_>, scope: &str, name: &str, value: &str) {
        store
            .change(scope, |values| {
                values.insert(name.into(), value.into());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn repository_overrides_user_without_leaking_to_other_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "SHARED", "user-secret");
        add(&store, USER, "USER_ONLY", "all");
        let before = store.resolve(Some("repo-a".into())).unwrap();
        add(&store, "repo-a", "SHARED", "repository-secret");
        add(&store, "repo-a", "REPO_ONLY", "private");
        let a = store.resolve(Some("repo-a".into())).unwrap();
        let b = store.resolve(Some("repo-b".into())).unwrap();
        assert_eq!(a.values["SHARED"], "repository-secret");
        assert_eq!(a.values["USER_ONLY"], "all");
        assert_eq!(b.values["SHARED"], "user-secret");
        assert!(!b.values.contains_key("REPO_ONLY"));
        assert_eq!(store.resolve(None).unwrap().values, b.values);
        assert!(before.stamp != a.stamp);
        let index = std::fs::read_to_string(dir.path().join("environment.json")).unwrap();
        for secret in ["user-secret", "repository-secret", "private"] {
            assert!(!index.contains(secret));
        }
        assert!(index.contains("SHARED"));
        store
            .change("repo-a", |values| {
                values.remove("SHARED");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            store.resolve(Some("repo-a".into())).unwrap().values["SHARED"],
            "user-secret"
        );
        assert!(b.stamp == store.resolve(Some("repo-b".into())).unwrap().stamp);
    }

    #[test]
    fn imports_are_atomic_and_edits_reject_duplicates_in_the_same_scope() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        let input = |name: &str| Input {
            name: name.into(),
            value: "secret".into(),
        };
        store
            .save(
                USER,
                (0..10).map(|i| input(&format!("KEY_{i}"))).collect(),
                None,
            )
            .unwrap();
        assert_eq!(store.resolve(None).unwrap().values.len(), 10);
        assert!(store
            .save(USER, vec![input("NEW"), input("KEY_0")], None)
            .is_err());
        assert!(!store.resolve(None).unwrap().values.contains_key("NEW"));
        assert!(store
            .save(USER, vec![input("DUP"), input("DUP")], None)
            .is_err());
        assert!(store
            .save(USER, vec![input("KEY_1")], Some("KEY_0"))
            .is_err());
        assert!(store.resolve(None).unwrap().values.contains_key("KEY_0"));
        store
            .save(USER, vec![input("RENAMED")], Some("KEY_0"))
            .unwrap();
        assert!(!store.resolve(None).unwrap().values.contains_key("KEY_0"));
        store.save("repo", vec![input("KEY_1")], None).unwrap();
        assert_eq!(store.resolve(Some("repo".into())).unwrap().values.len(), 10);
    }

    #[test]
    fn concurrent_writes_keep_both_changes() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        std::thread::scope(|threads| {
            for name in ["FIRST", "SECOND"] {
                let secrets = &secrets;
                let root = dir.path().to_path_buf();
                threads.spawn(move || add(&Store { root, secrets }, USER, name, "secret"));
            }
        });
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        assert_eq!(store.resolve(None).unwrap().values.len(), 2);
    }

    #[test]
    fn failed_keychain_write_keeps_old_values_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "old");
        let before = store.resolve(None).unwrap();
        secrets.fail_writes(true);
        assert!(store
            .change(USER, |values| {
                values.insert("KEY".into(), "new-secret".into());
                Ok(())
            })
            .is_err());
        let after = store.resolve(None).unwrap();
        assert!(before.stamp == after.stamp);
        assert_eq!(after.values["KEY"], "old");
    }

    #[test]
    fn failed_index_write_keeps_the_previous_keychain_item() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "old");
        let before = store.resolve(None).unwrap();
        // Occupy write_atomic's temporary filename with a directory.
        std::fs::create_dir(
            dir.path()
                .join(format!("environment.tmp.{}", std::process::id())),
        )
        .unwrap();
        assert!(store
            .change(USER, |values| {
                values.insert("KEY".into(), "new".into());
                Ok(())
            })
            .is_err());
        let after = store.resolve(None).unwrap();
        assert_eq!(after.values["KEY"], "old");
        assert!(before.stamp == after.stamp);
    }

    #[test]
    fn invalid_names_reserved_names_and_nul_fail_before_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        for name in [
            "",
            "lower",
            "1KEY",
            "A=B",
            "A-B",
            "A\n",
            "TERMINALX_NEXT_TOKEN",
            "RACCOON_TAB_ID",
            "CODEX_HOME",
            "PATH",
            "TERM",
            "CLAUDECODE",
        ] {
            assert!(validate_name(name).is_err(), "{name}");
        }
        for name in ["API_KEY", "_KEY", "A1"] {
            validate_name(name).unwrap();
        }
        assert!(store
            .change(USER, |values| {
                values.insert("KEY".into(), "bad\0value".into());
                Ok(())
            })
            .is_err());
        assert!(secrets.calls().is_empty());
        assert!(!dir.path().join("environment.json").exists());
    }

    #[test]
    fn missing_or_invalid_keychain_items_fail_closed_without_echoing_values() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "KEY", "sensitive-value");
        let scope = store.index().unwrap()[USER].clone();
        secrets
            .set(SERVICE, &scope.revision, b"sensitive-value")
            .unwrap();
        let error = store.resolve(None).err().unwrap().to_string();
        assert!(!error.contains("sensitive-value"));
        secrets.delete(SERVICE, &scope.revision).unwrap();
        assert!(store.resolve(None).is_err());
        std::fs::write(dir.path().join("environment.json"), b"sensitive-value").unwrap();
        assert!(!store
            .resolve(None)
            .err()
            .unwrap()
            .to_string()
            .contains("sensitive-value"));
    }

    #[test]
    fn git_worktrees_subdirectories_and_symlinks_share_a_scope() {
        let repo = tempfile::tempdir().unwrap();
        crate::git::run(repo.path(), &["init", "-q"]).unwrap();
        crate::git::run(
            repo.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "initial",
            ],
        )
        .unwrap();
        let worktrees = tempfile::tempdir().unwrap();
        let worktree = worktrees.path().join("worktree");
        crate::git::run(
            repo.path(),
            &["worktree", "add", "--detach", worktree.to_str().unwrap()],
        )
        .unwrap();
        let subdir = worktree.join("subdir");
        std::fs::create_dir(&subdir).unwrap();
        assert!(repository(repo.path()).is_some());
        assert_eq!(repository(repo.path()), repository(&subdir));
        #[cfg(unix)]
        {
            let link = worktrees.path().join("link");
            std::os::unix::fs::symlink(&worktree, &link).unwrap();
            assert_eq!(repository(repo.path()), repository(&link));
        }
        assert_ne!(repository(repo.path()), repository(worktrees.path()));
    }

    #[test]
    fn env_file_read_is_bounded_and_rejects_non_files() {
        let repo = tempfile::tempdir().unwrap();
        crate::git::run(repo.path(), &["init", "-q"]).unwrap();
        let project = repo.path().to_str().unwrap();
        let file = repo.path().join(".env");
        std::fs::write(&file, "KEY=secret").unwrap();
        assert_eq!(
            read_env_file(project, file.to_str().unwrap()).unwrap(),
            "KEY=secret"
        );
        std::fs::write(&file, vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(read_env_file(project, file.to_str().unwrap()).is_err());
        std::fs::write(&file, [0xff]).unwrap();
        assert!(read_env_file(project, file.to_str().unwrap()).is_err());
        assert!(read_env_file(project, project).is_err());
        #[cfg(unix)]
        {
            let fifo = repo.path().join("fifo");
            let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            // SAFETY: a valid, NUL-terminated path in this test's private directory.
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            assert!(read_env_file(project, fifo.to_str().unwrap()).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolved_values_reach_shell_and_agent_ptys_literally() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = Store {
            root: dir.path().into(),
            secrets: &secrets,
        };
        add(&store, USER, "TEST_KEY", "user");
        add(
            &store,
            "repo",
            "TEST_KEY",
            "$(touch must-not-exist); 'quoted'\nsecond line",
        );
        for id in ["session:1", "tab:agent"] {
            let launch = store.resolve(Some("repo".into())).unwrap();
            let expected = launch.values["TEST_KEY"].clone();
            TEST_LAUNCH.with(|slot| *slot.borrow_mut() = Some(launch));
            let terminals = crate::pty::Terminals::new();
            let sink = std::sync::Arc::new(crate::sink::BroadcastSink::new(64));
            terminals
                .spawn(
                    sink,
                    id,
                    crate::pty::PaneSpec {
                        cwd: dir.path().to_str().unwrap(),
                        cols: 80,
                        rows: 24,
                        command: Some("/usr/bin/printf '%s' \"$TEST_KEY\""),
                        env: &[],
                    },
                )
                .unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let output = String::from_utf8(terminals.read_output(id).unwrap_or_default())
                    .unwrap()
                    .replace("\r\n", "\n");
                if output.contains(&expected) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the PTY did not receive the resolved value"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            terminals.kill_all();
            assert!(!dir.path().join("must-not-exist").exists());
        }
    }
}
