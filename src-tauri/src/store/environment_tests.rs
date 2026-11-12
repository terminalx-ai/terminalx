//! PRO-144: values kept outside the Keychain by choice, where each row comes
//! from, and that no Keychain value reaches a file, a log or an export.
use super::*;
use crate::keychain::testing::MemorySecrets;
use super::super::configuration::{Layer, ResolvedValue, Resolution, REGISTRY};

fn input(name: &str, value: &str, secret: bool) -> Input {
    Input { name: name.into(), value: value.into(), secret }
}

fn row<'a>(rows: &'a [Row], scope: &str, name: &str) -> &'a Row {
    rows.iter().find(|row| row.scope == scope && row.name == name).unwrap_or_else(|| panic!("no {scope} row {name}"))
}

#[test]
fn plain_values_live_in_the_index_and_secrets_only_in_the_keychain() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = Store { root: dir.path().into(), secrets: &secrets };
    store.save(USER, vec![input("API_TOKEN", "tok-private-1", true), input("NODE_OPTIONS", "--max-old-space-size=8192", false)], None).unwrap();
    store.save("repository:/repo/.git", vec![input("NODE_OPTIONS", "--inspect", false)], None).unwrap();
    let index = std::fs::read_to_string(dir.path().join("environment.json")).unwrap();
    assert!(index.contains("--max-old-space-size=8192"), "the plain value is stored plainly");
    assert!(!index.contains("tok-private-1"));

    let launch = store.resolve(Some("repository:/repo/.git".into())).unwrap();
    assert_eq!(launch.values["API_TOKEN"], "tok-private-1");
    assert_eq!(launch.values["NODE_OPTIONS"], "--inspect", "the repository overrides Personal");
    assert_eq!(store.resolve(None).unwrap().values["NODE_OPTIONS"], "--max-old-space-size=8192");

    // A name is in one place only; an edit can move it between them.
    assert!(store.save(USER, vec![input("API_TOKEN", "again", false)], None).is_err());
    store.save(USER, vec![input("NODE_OPTIONS", "now-a-secret", true)], Some("NODE_OPTIONS")).unwrap();
    let index = std::fs::read_to_string(dir.path().join("environment.json")).unwrap();
    assert!(!index.contains("now-a-secret") && !index.contains("--max-old-space-size"));
    assert_eq!(store.resolve(None).unwrap().values["NODE_OPTIONS"], "now-a-secret");

    // A scope with only plain values needs no Keychain item at all.
    let only_plain = MemorySecrets::default();
    let plain_dir = tempfile::tempdir().unwrap();
    let plain_store = Store { root: plain_dir.path().into(), secrets: &only_plain };
    plain_store.save(USER, vec![input("PORT", "3000", false)], None).unwrap();
    assert_eq!(plain_store.resolve(None).unwrap().values["PORT"], "3000");
    plain_store.change_entries(USER, |entries| { assert!(entries.remove("PORT")); Ok(()) }).unwrap();
    assert!(plain_store.resolve(None).unwrap().values.is_empty());
}

#[test]
fn unavailable_keychain_values_withhold_plain_ones_too() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = Store { root: dir.path().into(), secrets: &secrets };
    store.save(USER, vec![input("API_TOKEN", "tok", true), input("API_URL", "https://example.test", false)], None).unwrap();
    // Nothing installed in the cache: the launch gets no partial set.
    let launch = Cache::default().resolve(Some(&store.index().unwrap()), None);
    assert!(launch.stamp.unavailable);
    assert!(launch.values.is_empty());
    // Plain values alone need no cache fill.
    let plain_dir = tempfile::tempdir().unwrap();
    let plain = Store { root: plain_dir.path().into(), secrets: &secrets };
    plain.save(USER, vec![input("API_URL", "https://example.test", false)], None).unwrap();
    let launch = Cache::default().resolve(Some(&plain.index().unwrap()), None);
    assert!(!launch.stamp.unavailable);
    assert_eq!(launch.values["API_URL"], "https://example.test");
}

#[test]
fn rows_say_where_a_value_comes_from_and_what_it_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = Store { root: dir.path().into(), secrets: &secrets };
    let repo = "repository:/code/app/.git";
    store.save(USER, vec![input("DATABASE_URL", "postgres://localhost/dev", false), input("API_TOKEN", "tok", true), input("SHARED_URL", "u", false)], None).unwrap();
    store.save(repo, vec![input("DATABASE_URL", "postgres://localhost/app", false), input("STRIPE_SECRET_KEY", "sk", true), input("SHARED_URL", "mine", false)], None).unwrap();
    let index = store.index().unwrap();

    let personal = rows(&index, USER);
    assert_eq!(row(&personal, "user", "DATABASE_URL").overridden_in, vec!["/code/app/.git".to_string()]);
    assert!(row(&personal, "user", "API_TOKEN").overridden_in.is_empty());
    assert_eq!(row(&personal, "user", "API_TOKEN").value, None, "Keychain values are never listed");
    assert_eq!(row(&personal, "user", "DATABASE_URL").value.as_deref(), Some("postgres://localhost/dev"));

    let mut project = rows(&index, repo);
    let resolved = |source| ResolvedValue { value: serde_json::Value::Null, source, locked: false, redacted: true };
    let resolution = Resolution {
        values: [
            ("environment.VITE_RELAY_URL".to_string(), resolved(Layer::RepositoryShared)),
            ("environment.SHARED_URL".to_string(), resolved(Layer::RepositoryShared)),
            ("environment.STRIPE_SECRET_KEY".to_string(), resolved(Layer::RepositoryLocal)),
            ("branchPrefix".to_string(), resolved(Layer::Defaults)),
        ].into(),
        registry: REGISTRY, warnings: Vec::new(), trust: None,
    };
    merge_file_rows(&mut project, &resolution);
    assert!(row(&project, "user", "DATABASE_URL").overridden, "from Personal, overridden here");
    assert!(!row(&project, "user", "API_TOKEN").overridden);
    assert!(!row(&project, "repository", "DATABASE_URL").overridden);
    assert!(row(&project, "repository", "STRIPE_SECRET_KEY").secret);
    assert!(row(&project, "repository", "STRIPE_SECRET_KEY").overridden, "the local file wins over the Keychain");
    assert!(!row(&project, "repositoryShared", "VITE_RELAY_URL").overridden);
    assert!(row(&project, "repositoryShared", "SHARED_URL").overridden, "this repository's own variable wins over the shared file");
    assert!(!row(&project, "repository", "SHARED_URL").overridden);
    assert!(project.iter().filter(|row| row.scope.starts_with("repositoryS") || row.scope == "repositoryLocal").all(|row| row.value.is_none()), "file values stay out of the list");
    assert!(!project.iter().any(|row| row.name == "branchPrefix"));
}

/// A value kept in the Keychain appears in no settings file, no log line, no
/// listed row, no Layered configuration view and no diagnostics export, also
/// when an operation on it fails.
#[test]
fn no_secret_value_reaches_settings_files_logs_or_the_diagnostics_export() {
    const SECRET: &str = "sk-live-PRO144-0b9e7c55d2a14f6f";
    crate::test_log::capture();
    let dir = tempfile::tempdir().unwrap();
    let secrets = MemorySecrets::default();
    let store = Store { root: dir.path().into(), secrets: &secrets };
    let repo = "repository:/code/app/.git";
    store.save(USER, vec![input("OPENAI_API_KEY", SECRET, true), input("NODE_OPTIONS", "--inspect", false)], None).unwrap();
    store.save(repo, vec![input("STRIPE_SECRET_KEY", SECRET, true)], None).unwrap();
    // Failures name the variable, never the value.
    for error in [
        store.save(USER, vec![input("OPENAI_API_KEY", SECRET, true)], None).unwrap_err(),
        store.save(USER, vec![input("lower", SECRET, true)], None).unwrap_err(),
        store.save(USER, vec![input("NUL_KEY", &format!("{SECRET}\0"), true)], None).unwrap_err(),
        store.save(USER, vec![input("PLAIN", SECRET, false), input("PLAIN", SECRET, true)], None).unwrap_err(),
    ] {
        assert!(!format!("{error:#}").contains(SECRET));
    }
    store.save(USER, vec![input("RENAMED_KEY", SECRET, true)], Some("OPENAI_API_KEY")).unwrap();
    assert_eq!(store.resolve(Some(repo.into())).unwrap().values["RENAMED_KEY"], SECRET);
    store.change_entries(repo, |entries| { assert!(entries.remove("STRIPE_SECRET_KEY")); Ok(()) }).unwrap();

    fn files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() { files(&path, out) } else { out.push(path) }
        }
    }
    let mut all = Vec::new();
    files(dir.path(), &mut all);
    assert!(all.iter().any(|path| path.ends_with("environment.json")));
    for path in &all {
        assert!(!String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(SECRET), "{} holds a secret value", path.display());
    }
    assert!(crate::test_log::logged(SECRET).is_empty(), "a secret value was logged");
    assert!(crate::test_log::logged(&SECRET[8..24]).is_empty());

    let index = store.index().unwrap();
    for key in [USER, repo] {
        assert!(!serde_json::to_string(&rows(&index, key)).unwrap().contains(SECRET));
    }
    // What Layered configuration shows for these rows is redacted too.
    let mut view = Resolution { values: BTreeMap::new(), registry: REGISTRY, warnings: Vec::new(), trust: None };
    view.values.insert("environment.RENAMED_KEY".into(), ResolvedValue { value: serde_json::json!(SECRET), source: Layer::RepositoryShared, locked: false, redacted: false });
    assert!(!serde_json::to_string(&view.redacted()).unwrap().contains(SECRET));

    #[cfg(feature = "desktop")]
    {
        use crate::cloud_diagnostics::{build_export, AppInfo, ExportInputs};
        let error = crate::cloud_workspaces::CloudWorkspaceClientError { code: "account_signed_out".into(), status: None, retryable: false, retry_after_seconds: None, retry_with_same_idempotency_key: false, requires_original_account_context: false };
        let export = build_export(&ExportInputs { app: AppInfo { version: "0".into(), os: "macos".into(), arch: "aarch64".into() }, exported_at: 0, window_days: 7, organization_id: None, server: Err(&error), closes: &[] });
        assert!(!export.to_string().contains(SECRET), "the diagnostics export holds a secret value");
    }
}
