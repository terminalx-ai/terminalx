//! The configuration identity of one Claude launch. The default user directory
//! and the default global JSON file have DIFFERENT parents. Making the default
//! directory an explicit override changes which global configuration Claude reads.

use std::path::PathBuf;

use anyhow::{ensure, Context, Result};

// This bounded route supports the ordinary on-disk configuration namespace.
// These selectors are not all covered by Claude's provider-env host filter.
// Values may contain credentials; capture only presence, never their contents.
const UNSUPPORTED_SELECTORS: &[&str] = &[
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_PROJECT_DIR_NAME",
    "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
    "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
    "CLAUDE_CODE_MOCK_REMOTE_SETTINGS",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CLAUDE_CODE_IGNORE_PERSISTED_TRUST",
    "CLAUDE_CODE_RELAUNCH_HOME_TRUST",
];
const SELECTOR_ERROR: &str = "This Bedrock launch uses an unsupported Claude configuration selector. Reconcile the runtime environment, workspace configuration and user settings before starting it. Existing configuration was not changed.";
fn admitted_selector(name: &str, value: &str) -> bool {
    // Empty secure-storage roots, for example, differ from absent ones. Only
    // the OAuth filename selector has an admitted explicit-empty contract.
    name.eq_ignore_ascii_case("CLAUDE_CODE_CUSTOM_OAUTH_URL") && value.is_empty()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    home: PathBuf,
    override_dir: Option<String>,
    unsupported_selector: bool,
    empty_selectors: Vec<String>,
}

impl Identity {
    pub fn new(home: PathBuf, override_dir: Option<String>) -> Self {
        Self {
            home,
            override_dir,
            unsupported_selector: false,
            empty_selectors: Vec::new(),
        }
    }

    pub fn from_environment(
        home: PathBuf,
        read: impl Fn(&str) -> Option<std::ffi::OsString>,
    ) -> Result<Self> {
        let override_dir = read("CLAUDE_CONFIG_DIR")
            .map(|value| {
                value.into_string().map_err(|_| {
                    anyhow::anyhow!("Claude configuration directory is not valid Unicode.")
                })
            })
            .transpose()?;
        let mut identity = Self::new(home, override_dir);
        for &name in UNSUPPORTED_SELECTORS {
            if let Some(value) = read(name) {
                if value.is_empty() && admitted_selector(name, "") {
                    identity.empty_selectors.push(name.into());
                } else {
                    identity.unsupported_selector = true;
                }
            }
        }
        Ok(identity)
    }

    /// Check every contributed value, even one a later layer might mask.
    /// Claude can consume configuration before applying every settings layer.
    /// Refuse incompatible input; never silently clear a selected namespace.
    pub fn admit_contribution<'a>(
        &self,
        env: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<()> {
        ensure!(!self.unsupported_selector, SELECTOR_ERROR);
        for (name, value) in env {
            ensure!(
                admitted_selector(name, value)
                    || !UNSUPPORTED_SELECTORS
                        .iter()
                        .any(|selector| name.eq_ignore_ascii_case(selector)),
                SELECTOR_ERROR
            );
        }
        Ok(())
    }

    pub fn capture_contribution<'a>(
        &mut self,
        env: impl IntoIterator<Item = (&'a str, &'a str)> + Clone,
    ) -> Result<()> {
        self.admit_contribution(env.clone())?;
        for (name, _) in env {
            if UNSUPPORTED_SELECTORS.contains(&name)
                && !self.empty_selectors.iter().any(|empty| empty == name)
            {
                self.empty_selectors.push(name.into());
            }
        }
        Ok(())
    }

    pub fn admit_local_environment(
        &mut self,
        env: &std::collections::BTreeMap<String, String>,
    ) -> Result<()> {
        self.capture_contribution(
            env.iter()
                .map(|(name, value)| (name.as_str(), value.as_str())),
        )?;
        if let Some(value) = env.get("CLAUDE_CONFIG_DIR") {
            ensure!(
                Some(value.as_str()) == self.override_dir.as_deref(),
                SELECTOR_ERROR
            );
        }
        if let Some(value) = env.get("HOME") {
            ensure!(Some(value.as_str()) == self.home.to_str(), SELECTOR_ERROR);
        }
        Ok(())
    }

    pub fn user_dir(&self) -> PathBuf {
        self.override_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".claude"))
    }

    pub fn global_file(&self) -> PathBuf {
        self.override_dir
            .as_ref()
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.clone())
            .join(".claude.json")
    }

    pub fn projects(&self) -> PathBuf {
        self.user_dir().join("projects")
    }
    pub fn backups(&self) -> PathBuf {
        self.user_dir().join("backups")
    }

    /// Pin the chosen identity after workspace env and before process creation.
    /// None means REMOVE the override, not set it to the default directory or
    /// an empty string. Claude's user-root resolver distinguishes empty/absent.
    pub fn launch_env(&self) -> Vec<(String, Option<String>)> {
        let mut env = vec![
            (
                "HOME".into(),
                Some(self.home.to_string_lossy().into_owned()),
            ),
            ("CLAUDE_CONFIG_DIR".into(), self.override_dir.clone()),
        ];
        // Admission rejected every nonempty contributor before preparation.
        // Preserve captured empty/absent ambient values at the spawn boundary.
        env.extend(UNSUPPORTED_SELECTORS.iter().map(|&name| {
            (
                name.into(),
                self.empty_selectors
                    .iter()
                    .any(|empty| empty == name)
                    .then(String::new),
            )
        }));
        env
    }

    pub fn pin_settings(&self, settings: &mut serde_json::Value) {
        // No deletion sentinel is supported in settings env. The default
        // stays absent; admission rejects user settings that redirect it.
        if let Some(dir) = &self.override_dir {
            settings["env"]["CLAUDE_CONFIG_DIR"] = dir.clone().into();
        }
        settings["env"]["HOME"] = self.home.to_string_lossy().into_owned().into();
    }

    /// Claude NFC-normalizes its user root, but lexically joins its global
    /// file without NFC normalization. Admit only roots whose spelling is
    /// unchanged by either operation. Never canonicalize: following a symlink
    /// before `..` can select a different file from Node's lexical path.join.
    /// Check raw strings, because Path::components already erases some dots
    /// and repeated separators. This check performs no filesystem access.
    fn validate_paths(&self) -> Result<()> {
        const ERROR: &str = "Claude configuration paths are ambiguous for this Bedrock launch. Use absolute NFC-normalized HOME and CLAUDE_CONFIG_DIR paths without dot components or repeated/trailing separators. Existing configuration was not changed.";
        let valid = |value: &str| {
            value.starts_with('/')
                && !value.contains('\0')
                && icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(value) == value
                && (value == "/"
                    || value[1..]
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != ".."))
        };
        ensure!(self.home.to_str().is_some_and(valid), ERROR);
        if let Some(dir) = &self.override_dir {
            ensure!(valid(dir), ERROR);
        }
        Ok(())
    }

    /// The explicit route cannot admit a different user/global root from the
    /// one it prepares. Project/local settings cannot set these variables in
    /// the supported CLI; managed settings are separately refused by Bedrock.
    /// Never echo config contents, and never rewrite a redirect to hide it.
    pub fn admit(&self) -> Result<()> {
        self.validate_paths()?;
        self.admit_contribution(std::iter::empty())?;
        // The supported CLI's full filename resolver prefers this legacy file
        // in several cases. Do not migrate it or prepare the other candidate.
        match std::fs::symlink_metadata(self.user_dir().join(".config.json")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => anyhow::bail!("This Bedrock launch cannot admit a legacy Claude global configuration. Reconcile the existing configuration before starting it; no configuration was changed."),
        }
        const ERROR: &str = "Claude configuration redirects this Bedrock launch. Set an absolute CLAUDE_CONFIG_DIR on the runtime and reconcile its user settings before starting the route.";
        let bytes = match std::fs::read(self.user_dir().join("settings.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => anyhow::bail!(
                "Could not read Claude user settings for Bedrock configuration admission."
            ),
        };
        let settings: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
            anyhow::anyhow!(
                "Could not parse Claude user settings for Bedrock configuration admission."
            )
        })?;
        ensure!(
            settings.is_object() && settings.get("env").is_none_or(|env| env.is_object()),
            "Could not parse Claude user settings for Bedrock configuration admission."
        );
        if let Some(env) = settings.get("env").and_then(|env| env.as_object()) {
            for (name, value) in env {
                if UNSUPPORTED_SELECTORS
                    .iter()
                    .any(|selector| name.eq_ignore_ascii_case(selector))
                {
                    ensure!(
                        value
                            .as_str()
                            .is_some_and(|value| admitted_selector(name, value)),
                        SELECTOR_ERROR
                    );
                }
            }
        }
        if let Some(value) = settings
            .get("env")
            .and_then(|env| env.get("CLAUDE_CONFIG_DIR"))
        {
            ensure!(
                value.as_str().is_some() && value.as_str() == self.override_dir.as_deref(),
                ERROR
            );
        }
        if let Some(value) = settings.get("env").and_then(|env| env.get("HOME")) {
            ensure!(value.as_str() == self.home.to_str(), ERROR);
        }
        Ok(())
    }
}

/// Resolve once per launch, before either admission or trust writes. Tests
/// never read the developer's home/configuration, even with a real env override.
pub fn current() -> Result<Identity> {
    #[cfg(test)]
    {
        if let Some(identity) = TEST_IDENTITY.with(|slot| slot.borrow().clone()) {
            return Ok(identity);
        }
        crate::store::state_home_env()
            .map(|home| Identity::new(PathBuf::from(home).join("test-user-home"), None))
            .context("no test home directory")
    }
    #[cfg(not(test))]
    {
        Identity::from_environment(dirs::home_dir().context("no home directory")?, |name| {
            std::env::var_os(name)
        })
    }
}

#[cfg(test)]
thread_local! {
    static TEST_IDENTITY: std::cell::RefCell<Option<Identity>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn with_identity<T>(identity: Identity, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<Identity>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_IDENTITY.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(TEST_IDENTITY.with(|slot| slot.replace(Some(identity))));
    run()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_selectors_are_checked_in_every_contribution_without_exposing_values() {
        for &name in UNSUPPORTED_SELECTORS {
            for value in ["https://synthetic.invalid/?secret=fixture", "0", " "] {
                let identity =
                    Identity::from_environment(PathBuf::from("/synthetic/home"), |key| {
                        (key == name).then(|| value.into())
                    })
                    .unwrap();
                assert!(identity
                    .admit()
                    .unwrap_err()
                    .to_string()
                    .contains("unsupported Claude configuration selector"));
                if value.starts_with("https:") {
                    assert!(!format!("{identity:?}").contains(value));
                }
                let ordinary = Identity::new(PathBuf::from("/synthetic/home"), None);
                assert!(ordinary.admit_contribution([(name, value)]).is_err());
                assert_eq!(
                    ordinary.admit_contribution([(name, "")]).is_ok(),
                    name == "CLAUDE_CODE_CUSTOM_OAUTH_URL"
                );
            }
        }
    }

    #[test]
    fn configuration_identity_matches_the_installed_cli_path_contract() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/configuration-paths.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let identity = Identity::new(
                PathBuf::from(case["home"].as_str().unwrap()),
                case["overrideDir"].as_str().map(String::from),
            );
            let admitted = case["admitted"].as_bool().unwrap();
            assert_eq!(identity.validate_paths().is_ok(), admitted, "{case}");
            if !admitted {
                // The artifact's transformed roots are deliberately not used:
                // rejection must precede every configuration read/write.
                assert!(identity
                    .admit()
                    .unwrap_err()
                    .to_string()
                    .contains("paths are ambiguous"));
                continue;
            }
            assert_eq!(
                identity.global_file(),
                PathBuf::from(case["globalFile"].as_str().unwrap())
            );
            assert_eq!(
                identity.user_dir(),
                PathBuf::from(case["userDir"].as_str().unwrap())
            );
            assert_eq!(identity.projects(), identity.user_dir().join("projects"));
        }
    }

    #[test]
    fn ambiguous_empty_or_relative_roots_are_not_admitted() {
        let empty = Identity::new(PathBuf::from("/synthetic/home"), Some(String::new()));
        assert_eq!(
            empty.global_file(),
            PathBuf::from("/synthetic/home/.claude.json")
        );
        for value in ["", "relative", ".claude"] {
            assert!(
                Identity::new(PathBuf::from("/synthetic/home"), Some(value.into()))
                    .admit()
                    .is_err()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_home_is_rejected_before_configuration_access() {
        use std::os::unix::ffi::OsStringExt;
        let home = std::ffi::OsString::from_vec(b"/synthetic/invalid-\xff".to_vec());
        assert!(Identity::new(PathBuf::from(home), None)
            .admit()
            .unwrap_err()
            .to_string()
            .contains("paths are ambiguous"));
    }
}
