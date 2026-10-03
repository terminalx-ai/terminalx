use url::Url;

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
        }
        assert!(DesktopLinks::Release.accepts_scheme("terminalx-next"));
    }
}
