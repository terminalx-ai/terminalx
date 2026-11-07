use url::Url;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct WorkspaceLink {
    pub org: String,
    pub number: u32,
}

impl WorkspaceLink {
    pub fn valid(&self) -> bool {
        let bytes = self.org.as_bytes();
        !bytes.is_empty() && bytes.len() <= 63
            && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
            && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            && self.number > 0 && self.number <= i32::MAX as u32
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

    pub fn workspace_link(self, url: &Url) -> Option<WorkspaceLink> {
        if !self.accepts_scheme(url.scheme()) || url.host_str() != Some("o")
            || !url.username().is_empty() || url.password().is_some()
            || url.port().is_some() || url.query().is_some() || url.fragment().is_some()
        { return None; }
        let parts: Vec<_> = url.path().split('/').collect();
        if parts.len() != 4 || !parts[0].is_empty() || parts[2] != "w"
            || parts[3].starts_with('0') || !parts[3].bytes().all(|b| b.is_ascii_digit())
        { return None; }
        let link = WorkspaceLink { org: parts[1].into(), number: parts[3].parse().ok()? };
        link.valid().then_some(link)
    }

    pub fn is_join_link(self, url: &Url) -> bool {
        self.accepts_scheme(url.scheme()) && url.host_str() == Some("join")
            && matches!(url.path(), "" | "/") && url.query().is_none() && url.fragment().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_links_are_strict_and_build_scoped() {
        let release = DesktopLinks::Release;
        assert_eq!(release.workspace_link(&Url::parse("terminalx://o/acme-team/w/12").unwrap()),
            Some(WorkspaceLink { org: "acme-team".into(), number: 12 }));
        assert!(DesktopLinks::Dev.workspace_link(&Url::parse("terminalx-dev://o/acme/w/1").unwrap()).is_some());
        for raw in ["terminalx-dev://o/acme/w/1", "https://o/acme/w/1", "terminalx://o/acme/w/0",
            "terminalx://o/acme/w/01", "terminalx://o/acme/w/-1", "terminalx://o/acme/w/2147483648",
            "terminalx://o/acme/w/1/", "terminalx://o/acme/w/1?token=x", "terminalx://o/acme/w/1#x",
            "terminalx://user@o/acme/w/1", "terminalx://o:123/acme/w/1", "terminalx://o/Acme/w/1",
            "terminalx://o/ac%2Fme/w/1", "terminalx://o/-acme/w/1", "terminalx://o/acme/w/+1"] {
            assert!(release.workspace_link(&Url::parse(raw).unwrap()).is_none(), "{raw}");
        }
    }

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
