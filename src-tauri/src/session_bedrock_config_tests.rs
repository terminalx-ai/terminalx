//! R4: the real session launch and trust preparation, with a synthetic account
//! grant and an offline executable that observes only the temporary config.
//! This is not a real Claude lifecycle or AWS smoke test.

use super::*;
use claude::configuration::Identity;
use serde_json::json;

const SESSION: &str = "bedrock-config";
const TAB: &str = "agent";
const CONVERSATION: &str = "12cfb036-cbbc-41df-8868-fb0979d00bca";

struct Rig {
    manager: SessionManager,
    identity: Identity,
    home: PathBuf,
    cwd: PathBuf,
    observed: PathBuf,
    original: Value,
    user_settings: String,
    workspace_env: Vec<(String, String)>,
    local_env: std::collections::BTreeMap<String, String>,
    _program: claude::pty::TestProgram,
    _state: store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals.kill_all();
    }
}

impl Rig {
    fn new(custom: bool) -> Self {
        let state = store::temp_home();
        let root = PathBuf::from(store::state_home_env().unwrap());
        let home = root.join("test-user-home");
        let cwd = root.join("checkout");
        std::fs::create_dir_all(&cwd).unwrap();
        let identity = Identity::new(
            home.clone(),
            custom.then(|| root.join("custom config").to_str().unwrap().to_string()),
        );
        std::fs::create_dir_all(identity.user_dir()).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let original = json!({
            "theme": "light-daltonized", "numStartups": 7,
            "mcpServers": {"synthetic": {"command": "synthetic-unused", "args": ["retain"]}},
            "projects": {(cwd.to_str().unwrap()): {"allowedTools": ["Read"], "mcpContextUris": ["synthetic://retained"]}}
        });
        // The default global file and explicitly selected .claude directory
        // are different identities. Neither unrelated file may be overwritten.
        std::fs::write(
            home.join(".claude.json"),
            r#"{"theme":"unselected-default"}"#,
        )
        .unwrap();
        std::fs::write(identity.global_file(), original.to_string()).unwrap();
        std::fs::write(
            identity
                .global_file()
                .with_file_name(".claude-custom-oauth.json"),
            r#"{"theme":"retain-custom-oauth","mcpServers":{"retained":{"command":"synthetic"}}}"#,
        )
        .unwrap();
        if !custom {
            std::fs::write(
                identity.user_dir().join(".claude.json"),
                r#"{"theme":"unselected-shadow"}"#,
            )
            .unwrap();
        }
        let user_settings = r#"{"permissions":{"deny":["Read(.env)"]},"env":{"AWS_BEARER_TOKEN_BEDROCK":"synthetic-stale"}}"#.to_string();
        std::fs::write(identity.user_dir().join("settings.json"), &user_settings).unwrap();
        std::fs::write(
            identity.user_dir().join("CLAUDE.md"),
            "Retain instructions\n",
        )
        .unwrap();
        let transcript = claude::transcript::transcript_in(
            &identity.projects(),
            cwd.to_str().unwrap(),
            CONVERSATION,
        );
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, "").unwrap();

        let program = root.join("observe-claude");
        let observed = root.join("observed.json");
        // Only the CLI boundary is substituted. Independently use Claude's
        // observed default/custom path rules, then inspect the ACTUAL file
        // prepared by SessionManager -> trust::prepare_for. Guard HOME first
        // so a regression cannot read a real user's global configuration.
        let script = format!(
            r##"#!/usr/bin/env python3
import json, os, pathlib, sys
home = pathlib.Path(os.environ['HOME'])
assert str(home) == {home}
config = os.environ.get('CLAUDE_CONFIG_DIR')
assert config is None or config == {custom_dir}
oauth = os.environ.get('CLAUDE_CODE_CUSTOM_OAUTH_URL')
global_file = pathlib.Path(config or home) / ('.claude-custom-oauth.json' if oauth else '.claude.json')
user_dir = pathlib.Path(config) if config is not None else home / '.claude'
args = sys.argv[1:]
settings = json.loads(args[args.index('--settings') + 1])
observed = {{'global': json.loads(global_file.read_text()), 'globalPath': str(global_file),
    'userPath': str(user_dir), 'configDir': config, 'customOAuth': oauth,
    'localValue': os.environ.get('SYNTHETIC_ADMITTED_LOCAL'), 'settings': settings, 'args': args,
    'userSettings': (user_dir / 'settings.json').read_text()}}
pathlib.Path({observed}).write_text(json.dumps(observed))
print('configuration-observed', flush=True)
sys.stdin.readline()
"##,
            home = json!(home),
            custom_dir = json!(identity.user_dir()),
            observed = json!(observed)
        );
        std::fs::write(&program, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let pinned = claude::pty::claude_program_for_tests(program);
        let manager = SessionManager::new(
            Arc::new(crate::sink::BroadcastSink::new(1024)),
            Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()),
            Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": SESSION, "projectPath": cwd, "cwd": cwd, "title": "Bedrock config fixture",
            "created": index::now(), "modified": index::now(),
            "tabs": [{"id": TAB, "harness": "claude", "permissionMode": "default",
                "providerSessionId": CONVERSATION, "created": index::now()}]
        }))
        .unwrap();
        index::save(&[entry]).unwrap();
        Self {
            manager,
            identity,
            home,
            cwd,
            observed,
            original,
            user_settings,
            workspace_env: Vec::new(),
            local_env: Default::default(),
            _program: pinned,
            _state: state,
        }
    }

    fn start(&self) -> Result<bool> {
        let fixture: Value =
            serde_json::from_str(include_str!("harness/claude/fixtures/bedrock-launch.json"))
                .unwrap();
        let public: Vec<(String, String)> = fixture["publicEnv"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_string()))
            .collect();
        let mut grant = crate::cloud_grants::LaunchGrant::default();
        grant.route = Some(crate::cloud_grants::RouteLaunch {
            bedrock: true,
            model: Some("synthetic-model".into()),
            claude_settings_env: public.clone(),
            ..Default::default()
        });
        grant.env = public
            .into_iter()
            .map(|(key, value)| (key, Some(value)))
            .collect();
        // Simulate a workspace env contribution trying to redirect the child.
        // The admitted configuration must replace/remove it at the last boundary.
        grant.env.push((
            "CLAUDE_CONFIG_DIR".into(),
            Some("/synthetic/unadmitted".into()),
        ));
        grant
            .env
            .push(("HOME".into(), Some("/synthetic/unadmitted-home".into())));
        let entry = index::get(SESSION)?;
        let tab = entry.tab(TAB).unwrap();
        let rt = self.manager.runtime(SESSION, TAB)?;
        claude::configuration::with_identity(self.identity.clone(), || {
            crate::cloud_grants::test_support::with_launch_grant(grant, || {
                crate::cloud_config::test_support::with_env(self.workspace_env.clone(), || {
                    crate::store::environment::with_launch(
                        crate::store::environment::Launch {
                            values: self.local_env.clone(),
                            stamp: Default::default(),
                        },
                        || {
                            self.manager
                                .start_cli(&mut rt.lock().unwrap(), &rt, &entry, tab, false)
                        },
                    )
                })
            })
        })
    }

    fn observed(&self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(bytes) = std::fs::read(&self.observed) {
                if let Ok(value) = serde_json::from_slice(&bytes) {
                    return value;
                }
            }
            assert!(
                Instant::now() < deadline,
                "fixture never observed prepared configuration"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_preserved(&self, custom: bool) {
        let oauth_file = self
            .identity
            .global_file()
            .with_file_name(".claude-custom-oauth.json");
        let oauth_before = std::fs::read(&oauth_file).unwrap();
        assert!(self.start().unwrap());
        let observed = self.observed();
        assert_eq!(observed["globalPath"], json!(self.identity.global_file()));
        assert_eq!(std::fs::read(oauth_file).unwrap(), oauth_before);
        assert_eq!(observed["userPath"], json!(self.identity.user_dir()));
        assert_eq!(observed["global"]["hasCompletedOnboarding"], true);
        assert_eq!(
            observed["global"]["projects"][self.cwd.to_str().unwrap()]["hasTrustDialogAccepted"],
            true
        );
        for key in ["theme", "numStartups", "mcpServers"] {
            assert_eq!(observed["global"][key], self.original[key]);
        }
        assert_eq!(
            observed["global"]["projects"][self.cwd.to_str().unwrap()]["allowedTools"],
            json!(["Read"])
        );
        assert_eq!(
            observed["global"]["projects"][self.cwd.to_str().unwrap()]["mcpContextUris"],
            json!(["synthetic://retained"])
        );
        assert_eq!(observed["userSettings"], self.user_settings);
        assert_eq!(
            std::fs::read_to_string(self.identity.user_dir().join("CLAUDE.md")).unwrap(),
            "Retain instructions\n"
        );
        assert!(observed["args"]
            .as_array()
            .unwrap()
            .contains(&json!("--resume")));
        assert_eq!(
            observed["settings"]["env"]["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"],
            "1"
        );
        assert_eq!(
            observed["settings"]["env"]["AWS_IGNORE_CONFIGURED_ENDPOINT_URLS"],
            "true"
        );
        assert_eq!(observed["settings"]["awsAuthRefresh"], "");
        assert_eq!(observed["settings"]["awsCredentialExport"], "");
        if custom {
            assert_eq!(observed["configDir"], json!(self.identity.user_dir()));
            assert_eq!(
                observed["settings"]["env"]["CLAUDE_CONFIG_DIR"],
                observed["configDir"]
            );
            assert_eq!(
                std::fs::read_to_string(self.home.join(".claude.json")).unwrap(),
                r#"{"theme":"unselected-default"}"#
            );
        } else {
            assert!(
                observed["configDir"].is_null(),
                "default must remain absent, not empty or an explicit .claude override"
            );
            assert!(observed["settings"]["env"]
                .get("CLAUDE_CONFIG_DIR")
                .is_none());
            assert_eq!(
                std::fs::read_to_string(self.identity.user_dir().join(".claude.json")).unwrap(),
                r#"{"theme":"unselected-shadow"}"#
            );
        }
        let rt = self.manager.runtime(SESSION, TAB).unwrap();
        let rt = rt.lock().unwrap();
        let Engine::Cli(cli) = &rt.engine else {
            panic!("not a CLI launch")
        };
        assert!(cli
            .origin
            .transcript_root
            .starts_with(self.identity.projects()));
        assert!(
            cli.usage_account.is_none(),
            "Bedrock is not the ambient OAuth account"
        );
    }
}

#[test]
fn bedrock_default_identity_prepares_and_launches_the_original_global_config() {
    Rig::new(false).assert_preserved(false);
}

#[test]
fn bedrock_custom_identity_prepares_and_launches_the_selected_global_config() {
    Rig::new(true).assert_preserved(true);
}

#[test]
fn bedrock_rejects_redirected_user_settings_before_trust_or_spawn() {
    let rig = Rig::new(false);
    let redirected =
        r#"{"env":{"CLAUDE_CONFIG_DIR":"/synthetic/other"},"permissions":{"deny":["Read(.env)"]}}"#;
    std::fs::write(rig.identity.user_dir().join("settings.json"), redirected).unwrap();
    assert!(rig
        .start()
        .unwrap_err()
        .to_string()
        .contains("configuration redirects"));
    assert!(!rig.observed.exists());
    assert_eq!(
        std::fs::read_to_string(rig.identity.global_file()).unwrap(),
        rig.original.to_string()
    );
    assert_eq!(
        std::fs::read_to_string(rig.identity.user_dir().join("settings.json")).unwrap(),
        redirected
    );
}

#[test]
fn bedrock_custom_policy_admission_uses_the_same_directory_before_preparation() {
    let rig = Rig::new(true);
    std::fs::write(
        rig.identity.user_dir().join("remote-settings.json"),
        "synthetic policy",
    )
    .unwrap();
    assert!(rig
        .start()
        .unwrap_err()
        .to_string()
        .contains("managed settings"));
    assert!(!rig.observed.exists());
    assert_eq!(
        std::fs::read_to_string(rig.identity.global_file()).unwrap(),
        rig.original.to_string()
    );
}

#[test]
fn bedrock_fresh_default_prepares_onboarding_and_trust_before_the_first_launch() {
    let rig = Rig::new(false);
    std::fs::remove_file(rig.identity.global_file()).unwrap();
    std::fs::remove_file(rig.identity.user_dir().join(".claude.json")).unwrap();
    index::update_tab(SESSION, TAB, |tab| {
        tab.provider_session_id = None;
        Ok(())
    })
    .unwrap();
    assert!(rig.start().unwrap());
    let observed = rig.observed();
    assert_eq!(observed["globalPath"], json!(rig.home.join(".claude.json")));
    assert_eq!(observed["global"]["hasCompletedOnboarding"], true);
    assert_eq!(
        observed["global"]["projects"][rig.cwd.to_str().unwrap()]["hasTrustDialogAccepted"],
        true
    );
    assert!(observed["args"]
        .as_array()
        .unwrap()
        .contains(&json!("--session-id")));
    assert!(observed["configDir"].is_null());
    assert!(!rig.identity.user_dir().join(".claude.json").exists());
    assert_eq!(observed["userSettings"], rig.user_settings);
}

#[test]
fn bedrock_never_replaces_an_unreadable_selected_global_config_with_a_new_one() {
    let rig = Rig::new(true);
    let invalid = "{ malformed synthetic global config";
    std::fs::write(rig.identity.global_file(), invalid).unwrap();
    assert!(rig
        .start()
        .unwrap_err()
        .to_string()
        .contains("Could not prepare the admitted Claude configuration"));
    assert!(!rig.observed.exists());
    assert_eq!(
        std::fs::read_to_string(rig.identity.global_file()).unwrap(),
        invalid
    );
}

#[test]
fn bedrock_rejects_decomposed_home_and_custom_roots_before_reading_or_preparing() {
    for custom in [false, true] {
        let mut rig = Rig::new(false);
        let original_file = rig.identity.global_file();
        let decomposed = rig.home.parent().unwrap().join("cafe\u{301}");
        rig.identity = if custom {
            Identity::new(rig.home.clone(), Some(decomposed.to_str().unwrap().into()))
        } else {
            Identity::new(decomposed, None)
        };
        std::fs::create_dir_all(rig.identity.user_dir()).unwrap();
        let global = rig.identity.global_file();
        let settings = rig.identity.user_dir().join("settings.json");
        // Invalid settings distinguish early path rejection from settings
        // parsing. On normalization-insensitive disks the NFC/NFD spellings
        // may alias: no distinct-directory assumption is made by this test.
        std::fs::write(&global, r#"{"theme":"preserve-decomposed"}"#).unwrap();
        std::fs::write(&settings, "not JSON; must not be read").unwrap();
        assert!(rig
            .start()
            .unwrap_err()
            .to_string()
            .contains("paths are ambiguous"));
        assert!(!rig.observed.exists());
        assert_eq!(
            std::fs::read_to_string(global).unwrap(),
            r#"{"theme":"preserve-decomposed"}"#
        );
        assert_eq!(
            std::fs::read_to_string(settings).unwrap(),
            "not JSON; must not be read"
        );
        assert_eq!(
            std::fs::read_to_string(original_file).unwrap(),
            rig.original.to_string()
        );
        assert!(!rig.identity.backups().exists());
    }
}

#[cfg(unix)]
#[test]
fn bedrock_rejects_parent_components_with_symlinks_before_either_config_is_touched() {
    for custom in [false, true] {
        let mut rig = Rig::new(false);
        let original_file = rig.identity.global_file();
        let root = rig.home.parent().unwrap();
        let lexical = root.join("selected");
        let physical = root.join("elsewhere/selected");
        std::fs::create_dir_all(root.join("elsewhere/child")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere/child"), root.join("link")).unwrap();
        let ambiguous = root.join("link/../selected");
        let mut preserved = Vec::new();
        for (dir, label) in [(&lexical, "lexical"), (&physical, "physical")] {
            std::fs::create_dir_all(dir.join(".claude")).unwrap();
            let global = dir.join(".claude.json");
            let contents =
                json!({"theme": label, "mcpServers": {"retain": {"command": "synthetic"}}})
                    .to_string();
            std::fs::write(&global, &contents).unwrap();
            preserved.push((global, contents));
            let settings = if custom {
                dir.join("settings.json")
            } else {
                dir.join(".claude/settings.json")
            };
            std::fs::write(&settings, "must not parse either path").unwrap();
            preserved.push((settings, "must not parse either path".into()));
        }
        // Demonstrate the actual filesystem counterexample independently of
        // the implementation: raw traversal and Node lexical joining differ.
        assert_eq!(
            ambiguous.canonicalize().unwrap(),
            physical.canonicalize().unwrap()
        );
        assert_ne!(
            ambiguous.canonicalize().unwrap(),
            lexical.canonicalize().unwrap()
        );
        rig.identity = if custom {
            Identity::new(rig.home.clone(), Some(ambiguous.to_str().unwrap().into()))
        } else {
            Identity::new(ambiguous, None)
        };
        assert!(rig
            .start()
            .unwrap_err()
            .to_string()
            .contains("paths are ambiguous"));
        assert!(!rig.observed.exists());
        for (path, contents) in preserved {
            assert_eq!(std::fs::read_to_string(path).unwrap(), contents);
        }
        assert_eq!(
            std::fs::read_to_string(original_file).unwrap(),
            rig.original.to_string()
        );
        assert!(!rig.identity.backups().exists());
    }
}

#[test]
fn bedrock_refuses_every_custom_oauth_contributor_before_preparing_either_global_file() {
    const KEY: &str = "CLAUDE_CODE_CUSTOM_OAUTH_URL";
    const VALUE: &str = "https://synthetic.invalid/?credential=synthetic-selector";
    for custom in [false, true] {
        for source in [
            "inherited",
            "workspace",
            "local-environment",
            "user-settings",
        ] {
            let mut rig = Rig::new(custom);
            match source {
                "inherited" => {
                    let config = custom.then(|| rig.identity.user_dir().into_os_string());
                    rig.identity =
                        Identity::from_environment(rig.home.clone(), |name| match name {
                            "CLAUDE_CONFIG_DIR" => config.clone(),
                            KEY => Some(VALUE.into()),
                            _ => None,
                        })
                        .unwrap();
                }
                "workspace" => {
                    assert!(crate::cloud_config::is_injectable_name(KEY));
                    rig.workspace_env.push((KEY.into(), VALUE.into()));
                }
                "local-environment" => {
                    rig.local_env.insert(KEY.into(), VALUE.into());
                }
                "user-settings" => {
                    std::fs::write(
                        rig.identity.user_dir().join("settings.json"),
                        json!({"env": {(KEY): VALUE}, "permissions": {"deny": ["Read(.env)"]}})
                            .to_string(),
                    )
                    .unwrap();
                }
                _ => unreachable!(),
            }
            let files = [
                rig.identity.global_file(),
                rig.identity
                    .global_file()
                    .with_file_name(".claude-custom-oauth.json"),
                rig.identity.user_dir().join("settings.json"),
            ];
            let before: Vec<_> = files
                .iter()
                .map(|file| std::fs::read(file).unwrap())
                .collect();
            let error = rig.start().unwrap_err().to_string();
            assert!(
                error.contains("unsupported Claude configuration selector"),
                "{source}: {error}"
            );
            assert!(!error.contains(VALUE));
            assert!(!format!("{:?}", rig.identity).contains(VALUE));
            assert!(!rig.observed.exists());
            assert!(!rig.identity.backups().exists());
            for (file, bytes) in files.iter().zip(before) {
                assert_eq!(std::fs::read(file).unwrap(), bytes);
            }
        }
    }
}

#[test]
fn bedrock_retains_an_explicit_empty_oauth_selector_and_ordinary_global_identity() {
    for custom in [false, true] {
        let mut rig = Rig::new(custom);
        rig.workspace_env
            .push(("CLAUDE_CODE_CUSTOM_OAUTH_URL".into(), String::new()));
        rig.local_env
            .insert("SYNTHETIC_ADMITTED_LOCAL".into(), "snapshot-value".into());
        rig.assert_preserved(custom);
        assert_eq!(rig.observed()["customOAuth"], "");
        assert_eq!(rig.observed()["localValue"], "snapshot-value");
    }
}

#[test]
fn bedrock_refuses_legacy_global_selection_without_migrating_any_preferences() {
    for custom in [false, true] {
        let rig = Rig::new(custom);
        let legacy = rig.identity.user_dir().join(".config.json");
        std::fs::write(&legacy, r#"{"theme":"legacy","mcpServers":{"retain":{}}}"#).unwrap();
        let files = [
            legacy,
            rig.identity.global_file(),
            rig.identity
                .global_file()
                .with_file_name(".claude-custom-oauth.json"),
        ];
        let before: Vec<_> = files
            .iter()
            .map(|file| std::fs::read(file).unwrap())
            .collect();
        assert!(rig
            .start()
            .unwrap_err()
            .to_string()
            .contains("legacy Claude global configuration"));
        assert!(!rig.observed.exists());
        assert!(!rig.identity.backups().exists());
        for (file, bytes) in files.iter().zip(before) {
            assert_eq!(std::fs::read(file).unwrap(), bytes);
        }
    }
}
