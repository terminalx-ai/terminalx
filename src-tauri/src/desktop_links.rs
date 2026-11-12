use std::sync::Mutex;

use serde::Serialize;
use url::Url;

/// The longest row id a setting link may name; registry ids are far shorter.
const MAX_SETTING_ID_LEN: usize = 64;

/// A setting link (`<scheme>://settings/<row-id>[?enable=1]`, PRO-127) after
/// validation: all the webview is ever handed of it, never the URL text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SettingsLink {
    pub id: String,
    pub enable: bool,
}

/// A plausible settings row id: letters, digits, '.', '-' and '_', starting
/// with a letter or digit, short. Whether it names a real row is the
/// webview's call (its registry), which opens Settings unchanged otherwise.
fn is_setting_id(id: &str) -> bool {
    (1..=MAX_SETTING_ID_LEN).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !id.contains("..")
}

/// The setting link that arrived last and the webview has not taken yet: a
/// link that launches the app comes before the webview listens, so it waits
/// here and is taken once, when the webview asks.
#[derive(Default)]
pub struct PendingSettingsLink(Mutex<Option<SettingsLink>>);

impl PendingSettingsLink {
    /// Keep `link` for the webview, in place of one it has not taken.
    pub fn set(&self, link: SettingsLink) {
        *self.0.lock().unwrap() = Some(link);
    }

    /// The waiting link, once: a second take returns None.
    pub fn take(&self) -> Option<SettingsLink> {
        self.0.lock().unwrap().take()
    }
}

/// Selected by the bundled Tauri identity, not Cargo's optimization profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopLinks {
    Release,
    Dev,
}

impl DesktopLinks {
    pub fn for_identifier(identifier: &str) -> Self {
        if identifier == "com.terminalx.next.dev" {
            Self::Dev
        } else {
            Self::Release
        }
    }

    pub fn redirect_uri(self) -> &'static str {
        match self {
            Self::Release => "terminalx://auth/callback",
            Self::Dev => "terminalx-dev://auth/callback",
        }
    }

    pub fn accepts_scheme(self, scheme: &str) -> bool {
        match self {
            Self::Release => matches!(scheme, "terminalx" | "terminalx-next"),
            Self::Dev => scheme == "terminalx-dev",
        }
    }

    pub fn is_launch_link(self, url: &Url) -> bool {
        self.accepts_scheme(url.scheme())
            && url.host_str() == Some("launch")
            && matches!(url.path(), "" | "/")
    }

    pub fn is_auth_callback(self, url: &Url) -> bool {
        self.accepts_scheme(url.scheme())
            && url.host_str() == Some("auth")
            && url.path() == "/callback"
    }

    pub fn is_join_link(self, url: &Url) -> bool {
        self.accepts_scheme(url.scheme()) && url.host_str() == Some("join")
            && matches!(url.path(), "" | "/") && url.query().is_none() && url.fragment().is_some()
    }

    /// A strictly shaped setting link: this build's scheme, host `settings`,
    /// exactly one path segment that is a plausible row id, no credentials,
    /// port or fragment, and no query but exactly `enable=1`. Anything else
    /// is None, so it never reaches the webview.
    pub fn settings_link(self, url: &Url) -> Option<SettingsLink> {
        if !self.accepts_scheme(url.scheme())
            || url.host_str() != Some("settings")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        let id = url.path().strip_prefix('/')?;
        if !is_setting_id(id) {
            return None;
        }
        let enable = match url.query() {
            None => false,
            Some("enable=1") => true,
            Some(_) => return None,
        };
        // The parsed parts must spell the whole link back: nothing the checks
        // above did not look at (an empty `?`, userinfo) slips through.
        let canonical = format!("{}://settings/{id}{}", url.scheme(), if enable { "?enable=1" } else { "" });
        (url.as_str() == canonical).then(|| SettingsLink { id: id.to_owned(), enable })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_identities_register_and_use_distinct_schemes() {
        let release: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let dev: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
        for (config, expected, scheme) in [
            (&release, DesktopLinks::Release, "terminalx"),
            (&dev, DesktopLinks::Dev, "terminalx-dev"),
        ] {
            let links = DesktopLinks::for_identifier(config["identifier"].as_str().unwrap());
            assert_eq!(links, expected);
            assert_eq!(
                config["plugins"]["deep-link"]["desktop"]["schemes"],
                serde_json::json!([scheme])
            );
            assert_eq!(links.redirect_uri(), format!("{scheme}://auth/callback"));
            assert!(links.is_auth_callback(&Url::parse(links.redirect_uri()).unwrap()));
            assert!(links.is_launch_link(&Url::parse(&format!("{scheme}://launch")).unwrap()));
            assert_eq!(
                links.settings_link(&Url::parse(&format!("{scheme}://settings/general.sounds")).unwrap()),
                Some(SettingsLink { id: "general.sounds".into(), enable: false })
            );
        }
    }

    #[test]
    fn each_build_rejects_the_other_builds_callbacks_and_launches() {
        for (links, rejected) in [
            (DesktopLinks::Release, "terminalx-dev"),
            (DesktopLinks::Dev, "terminalx"),
            (DesktopLinks::Dev, "terminalx-next"),
            (DesktopLinks::Release, "terminalx-legacy"),
            (DesktopLinks::Dev, "https"),
        ] {
            assert!(!links.accepts_scheme(rejected));
            assert!(!links.is_auth_callback(
                &Url::parse(&format!("{rejected}://auth/callback?code=secret")).unwrap()
            ));
            assert!(!links.is_launch_link(&Url::parse(&format!("{rejected}://launch")).unwrap()));
            for link in [format!("{rejected}://settings/general.sounds"), format!("{rejected}://settings/general.sounds?enable=1")] {
                assert_eq!(links.settings_link(&Url::parse(&link).unwrap()), None, "{links:?} took {link}");
            }
        }
        assert!(DesktopLinks::Release.accepts_scheme("terminalx-next"));
    }

    fn parse(links: DesktopLinks, link: &str) -> Option<SettingsLink> {
        links.settings_link(&Url::parse(link).unwrap())
    }

    #[test]
    fn each_build_takes_its_own_settings_links_with_or_without_enable() {
        for (links, scheme) in [
            (DesktopLinks::Release, "terminalx"),
            (DesktopLinks::Release, "terminalx-next"),
            (DesktopLinks::Dev, "terminalx-dev"),
        ] {
            assert_eq!(
                parse(links, &format!("{scheme}://settings/general.sounds")),
                Some(SettingsLink { id: "general.sounds".into(), enable: false })
            );
            assert_eq!(
                parse(links, &format!("{scheme}://settings/general.sounds?enable=1")),
                Some(SettingsLink { id: "general.sounds".into(), enable: true })
            );
            // Any plausible id gets through; the webview's registry says whether it is a row.
            assert_eq!(
                parse(links, &format!("{scheme}://settings/no-such_row.9")),
                Some(SettingsLink { id: "no-such_row.9".into(), enable: false })
            );
            // A settings link is none of the other kinds.
            let url = Url::parse(&format!("{scheme}://settings/general.sounds")).unwrap();
            assert!(!links.is_launch_link(&url) && !links.is_join_link(&url) && !links.is_auth_callback(&url));
        }
    }

    #[test]
    fn settings_links_outside_the_strict_shape_are_rejected_by_both_builds() {
        let long = "a".repeat(MAX_SETTING_ID_LEN + 1);
        for (links, scheme) in [(DesktopLinks::Release, "terminalx"), (DesktopLinks::Dev, "terminalx-dev")] {
            for tail in [
                "settings",
                "settings/",
                "settings/general.sounds/",
                "settings/general/sounds",
                "settings/general.sounds/extra",
                "settings/general.sounds#row",
                "settings/general.sounds#",
                "settings/general.sounds?",
                "settings/general.sounds?enable=0",
                "settings/general.sounds?enable=true",
                "settings/general.sounds?enable=1&x=1",
                "settings/general.sounds?x=1&enable=1",
                "settings/general.sounds?enable=1#row",
                "settings/general.sounds?ENABLE=1",
                "settings/general%2Esounds",
                "settings/general%2Fsounds",
                "settings/general%20sounds",
                "settings/-general.sounds",
                "settings/.general",
                "settings/general..sounds",
                "settings/génèral",
                "settings/general:sounds",
                "settings/general;sounds",
                "user@settings/general.sounds",
                "user:secret@settings/general.sounds",
                "settings:8080/general.sounds",
                "SETTINGS/general.sounds",
                "setting/general.sounds",
                "launch/general.sounds",
                "join/general.sounds",
                "auth/general.sounds",
            ] {
                let link = format!("{scheme}://{tail}");
                if let Ok(url) = Url::parse(&link) {
                    assert_eq!(links.settings_link(&url), None, "{links:?} took {link}");
                }
            }
            assert_eq!(parse(links, &format!("{scheme}://settings/{long}")), None);
            assert!(parse(links, &format!("{scheme}://settings/{}", &long[1..])).is_some());
        }
        // Other schemes never: not the web, not the legacy app.
        for link in ["https://settings/general.sounds", "terminalx-legacy://settings/general.sounds?enable=1", "file:///settings/general.sounds"] {
            for links in [DesktopLinks::Release, DesktopLinks::Dev] {
                assert_eq!(parse(links, link), None, "{links:?} took {link}");
            }
        }
    }

    #[test]
    fn a_pending_settings_link_is_taken_once_and_the_latest_wins() {
        let pending = PendingSettingsLink::default();
        assert_eq!(pending.take(), None);
        pending.set(SettingsLink { id: "general.sounds".into(), enable: false });
        pending.set(SettingsLink { id: "general.promptMap".into(), enable: true });
        assert_eq!(pending.take(), Some(SettingsLink { id: "general.promptMap".into(), enable: true }));
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn a_settings_link_reaches_the_webview_as_id_and_enable_only() {
        let link = parse(DesktopLinks::Release, "terminalx://settings/general.sounds?enable=1").unwrap();
        assert_eq!(serde_json::to_value(link).unwrap(), serde_json::json!({ "id": "general.sounds", "enable": true }));
    }
}
