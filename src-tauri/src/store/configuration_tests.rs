use super::*;

struct Fixture { _home: tempfile::TempDir, repo: tempfile::TempDir, store: Store }
impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        git(repo.path(), &["init", "-q"]).unwrap();
        std::fs::create_dir(repo.path().join(".terminalx")).unwrap();
        std::fs::write(repo.path().join(".terminalx/.gitignore"), "/settings.local.json\n").unwrap();
        let store = Store { home: home.path().canonicalize().unwrap(), managed_fixture: Some(home.path().join("system-policy-fixture.json")) };
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
    assert_eq!(r.values.len(), 2);
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
    let keys: Vec<&String> = schema["properties"].as_object().unwrap().keys().filter(|key| *key != "$schema").collect();
    assert_eq!(keys, REGISTRY.iter().filter(|key| key.repository_configurable).map(|key| key.key).collect::<Vec<_>>());
    assert_eq!(schema["additionalProperties"], false);
}
