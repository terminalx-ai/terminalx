use std::collections::VecDeque;
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

/// The longest session or tab id a tab link may name; the app's ids (UUIDs) are far shorter.
const MAX_TAB_LINK_ID_LEN: usize = 64;

/// A tab link (`<scheme>://tab/<session-id>/<tab-id>`, PRO-381) after
/// validation: all the webview is ever handed of it, never the URL text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabLink {
    pub session_id: String,
    pub tab_id: String,
}

/// A plausible session or tab id: letters, digits, '-' and '_', short.
/// Whether it names a tab that is still open is the webview's call.
fn is_tab_link_id(id: &str) -> bool {
    (1..=MAX_TAB_LINK_ID_LEN).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
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

impl DesktopLinks {
    /// The scheme this build's links are written in.
    pub fn scheme(self) -> &'static str {
        match self {
            Self::Release => "terminalx",
            Self::Dev => "terminalx-dev",
        }
    }

    /// The link that opens `tab_id` of `session_id`, or None for ids no link may carry.
    pub fn tab_link_url(self, session_id: &str, tab_id: &str) -> Option<String> {
        (is_tab_link_id(session_id) && is_tab_link_id(tab_id)).then(|| format!("{}://tab/{session_id}/{tab_id}", self.scheme()))
    }

    /// A strictly shaped tab link: this build's scheme, host `tab`, exactly
    /// two path segments that are plausible ids, and nothing else (no
    /// credentials, port, query or fragment). Anything else is None.
    pub fn tab_link(self, url: &Url) -> Option<TabLink> {
        if !self.accepts_scheme(url.scheme())
            || url.host_str() != Some("tab")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return None;
        }
        let (session_id, tab_id) = url.path().strip_prefix('/')?.split_once('/')?;
        if !is_tab_link_id(session_id) || !is_tab_link_id(tab_id) {
            return None;
        }
        let canonical = format!("{}://tab/{session_id}/{tab_id}", url.scheme());
        (url.as_str() == canonical).then(|| TabLink { session_id: session_id.to_owned(), tab_id: tab_id.to_owned() })
    }
}

/// The longest project path a `new` link may name.
const MAX_LINK_PATH_LEN: usize = 4096;
/// Git's own limit on a ref's name is the file system's; links keep to this.
const MAX_LINK_BRANCH_LEN: usize = 255;
/// The longest first prompt a `new` link may carry.
const MAX_LINK_PROMPT_LEN: usize = 16 * 1024;
/// The longest page address a `browser` link may carry.
const MAX_LINK_PAGE_LEN: usize = 8192;
/// How much of an invalid link goes back to the webview, to show and copy.
const MAX_SHOWN_LINK_LEN: usize = 2048;
/// How much of an unknown route's name the toast quotes.
const MAX_SHOWN_ROUTE_LEN: usize = 40;
/// Links kept for a webview that has not taken them; the oldest go first.
const MAX_PENDING_LINKS: usize = 8;

/// Why a link of this build's scheme cannot be followed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LinkProblem {
    /// The link names a route TerminalX has not got (`terminalx://sesion/…`).
    UnknownRoute { route: String },
    /// A known route, shaped wrongly: a missing or extra part, a value no
    /// session, branch or page could have.
    Malformed { route: String },
    /// A `browser` link to a page that is not on the web (`file:`, `javascript:`).
    NotWeb { scheme: String },
}

/// A `terminalx://` link after validation (PRO-130): all the webview is
/// handed of it. Every route the app follows is one of these, so settings,
/// tab, session, new-session and browser links share one event, one queue
/// and one router in the webview. Auth callbacks, launch and join links are
/// not routes: they are handled natively and never reach it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DesktopLink {
    Settings(SettingsLink),
    Tab(TabLink),
    /// `session/<id>`: show that session as it was last left.
    Session { session_id: String },
    /// `new?project=&branch=&prompt=` or `new?linear=<id>`: a new session,
    /// which the webview starts only after the person says yes. A missing
    /// project is the one last worked in; a missing branch the project's
    /// default. At least a prompt or an issue is always there.
    New {
        project: Option<String>,
        branch: Option<String>,
        prompt: Option<String>,
        /// A Linear issue's key, upper-cased (`PRO-130`).
        linear: Option<String>,
    },
    /// `browser?url=<http(s) url>`: the page in a Browser tab.
    Browser { url: String },
    /// A link of this build's scheme that cannot be followed. `link` is the
    /// link as it came, cut short, for the toast to show and copy.
    Invalid { link: String, problem: LinkProblem },
}

/// Routes handled natively, outside the router: never `Invalid`, whatever their shape,
/// so an auth callback's code is never handed on.
const NATIVE_ROUTES: [&str; 3] = ["auth", "launch", "join"];

/// A plausible Git branch name, as `git check-ref-format --branch` would take it.
fn is_branch_name(name: &str) -> bool {
    (1..=MAX_LINK_BRANCH_LEN).contains(&name.len())
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && !name.contains("/.")
        && name != "@"
        && !name.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

/// An absolute path with nothing a path from a link should carry: no
/// control characters, no `.`/`..` steps. Whether a project is there is the webview's call.
fn is_project_path(path: &str) -> bool {
    (2..=MAX_LINK_PATH_LEN).contains(&path.len())
        && path.starts_with('/')
        && !path.chars().any(char::is_control)
        && !path.split('/').any(|step| step == "." || step == "..")
}

/// A character that draws nothing or reorders what is drawn: zero-width
/// spaces and joiners, bidi controls, word joiners and invisible operators,
/// the byte-order mark, interlinear annotations and Unicode tags. In a
/// prompt they would carry words to the agent that the confirmation dialog
/// does not show.
fn is_hidden(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
        | 0x200B..=0x200F | 0x2028 | 0x2029 | 0x202A..=0x202E | 0x2060..=0x206F | 0x3164 | 0xFE00..=0xFE0F
        | 0xFEFF | 0xFFA0 | 0xFFF9..=0xFFFB | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

/// A first prompt: text, with line breaks and tabs, and no other control
/// character or hidden one: the dialog shows every character that is sent.
fn is_link_prompt(prompt: &str) -> bool {
    !prompt.trim().is_empty()
        && prompt.len() <= MAX_LINK_PROMPT_LEN
        && !prompt.chars().any(|c| (c.is_control() && !matches!(c, '\n' | '\r' | '\t')) || is_hidden(c))
        && !pads_out_of_view(prompt)
}

/// A character that draws no ink: any Unicode white space (the ideographic
/// and no-break spaces, the en and em spaces, …) and the blank braille
/// pattern. The webview's `isBlank` is the same rule.
fn is_blank(c: char) -> bool {
    c.is_whitespace() || c == '\u{2800}'
}

/// Blank space that would push words below what the dialog shows at first:
/// more than two blank lines in a row, or a run of 40 blank characters.
/// Lines break only at `\n` and `\r` (U+2028 and U+2029 are refused as hidden).
fn pads_out_of_view(prompt: &str) -> bool {
    let normalized = prompt.replace("\r\n", "\n").replace('\r', "\n");
    let mut blank_run = 0;
    for line in normalized.split('\n') {
        blank_run = if line.chars().all(is_blank) { blank_run + 1 } else { 0 };
        if blank_run > 2 {
            return true;
        }
    }
    let mut space_run = 0;
    normalized.chars().any(|c| {
        space_run = if c != '\n' && is_blank(c) { space_run + 1 } else { 0 };
        space_run >= 40
    })
}

/// A Linear issue key (`PRO-130`), upper-cased, or None.
fn linear_key(key: &str) -> Option<String> {
    let (team, number) = key.split_once('-')?;
    let team_ok = (1..=10).contains(&team.len())
        && team.starts_with(|c: char| c.is_ascii_alphabetic())
        && team.chars().all(|c| c.is_ascii_alphanumeric());
    let number_ok = (1..=9).contains(&number.len()) && !number.starts_with('0') && number.chars().all(|c| c.is_ascii_digit());
    (team_ok && number_ok).then(|| key.to_ascii_uppercase())
}

/// `s` cut to at most `max` bytes, on a character boundary.
fn cut(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

fn is_non_public_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    let cgnat = o[0] == 100 && (o[1] & 0b1100_0000) == 64;
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        || cgnat
}

fn is_non_public_ipv6(ip: std::net::Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_non_public_ipv4(mapped);
    }
    let seg0 = ip.segments()[0];
    let unique_local = (seg0 & 0xfe00) == 0xfc00;
    let link_local = (seg0 & 0xffc0) == 0xfe80;
    ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || unique_local || link_local
}

/// Whether `url` points to a loopback, link-local, or private-network host
/// that an external `terminalx://browser` deep link must never navigate to.
fn is_private_or_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => is_non_public_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => is_non_public_ipv6(ip),
        Some(url::Host::Domain(domain)) => {
            let host = domain.trim_end_matches('.').to_ascii_lowercase();
            if host.is_empty()
                || host == "localhost"
                || host.ends_with(".localhost")
                || host.ends_with(".local")
                || host.ends_with(".internal")
                || host.ends_with(".localdomain")
                || !host.contains('.')
            {
                return true;
            }
            if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
                return is_non_public_ipv4(ip);
            }
            if let Ok(ip) = host.parse::<std::net::Ipv6Addr>() {
                return is_non_public_ipv6(ip);
            }
            false
        }
        None => true,
    }
}

/// The query's pairs, decoded, when no name comes twice; None otherwise.
fn single_pairs(url: &Url) -> Option<Vec<(String, String)>> {
    let pairs: Vec<(String, String)> = url.query_pairs().map(|(name, value)| (name.into_owned(), value.into_owned())).collect();
    let mut names: Vec<&str> = pairs.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_unstable();
    names.windows(2).all(|pair| pair[0] != pair[1]).then_some(pairs)
}

impl DesktopLinks {
    /// What a link of this build's scheme asks for, or None for a link the
    /// router does not take: another scheme, or a natively handled route
    /// (auth, launch, join). Every other link of this scheme is a route the
    /// webview follows, or `Invalid` with why.
    pub fn route(self, url: &Url) -> Option<DesktopLink> {
        if !self.accepts_scheme(url.scheme()) {
            return None;
        }
        let host = url.host_str().unwrap_or("");
        if NATIVE_ROUTES.contains(&host) {
            return None;
        }
        let invalid = |problem: LinkProblem| Some(DesktopLink::Invalid { link: cut(url.as_str(), MAX_SHOWN_LINK_LEN), problem });
        let malformed = || invalid(LinkProblem::Malformed { route: host.to_owned() });
        // No route carries credentials, a port or a fragment.
        let plain = url.username().is_empty() && url.password().is_none() && url.port().is_none() && url.fragment().is_none();
        match host {
            "settings" => self.settings_link(url).map(DesktopLink::Settings).or_else(malformed),
            "tab" => self.tab_link(url).map(DesktopLink::Tab).or_else(malformed),
            "session" => {
                let id = url.path().strip_prefix('/').filter(|id| is_tab_link_id(id));
                match id {
                    Some(id) if plain && url.query().is_none() => Some(DesktopLink::Session { session_id: id.to_owned() }),
                    _ => malformed(),
                }
            }
            "new" => {
                if !plain || !matches!(url.path(), "" | "/") {
                    return malformed();
                }
                let Some(pairs) = single_pairs(url) else { return malformed() };
                let (mut project, mut branch, mut prompt, mut linear) = (None, None, None, None);
                for (name, value) in pairs {
                    match name.as_str() {
                        "project" if is_project_path(&value) => project = Some(value),
                        "branch" if is_branch_name(&value) => branch = Some(value),
                        "prompt" if is_link_prompt(&value) => prompt = Some(value),
                        "linear" => match linear_key(&value) {
                            Some(key) => linear = Some(key),
                            None => return malformed(),
                        },
                        _ => return malformed(),
                    }
                }
                if prompt.is_none() && linear.is_none() {
                    return malformed();
                }
                Some(DesktopLink::New { project, branch, prompt, linear })
            }
            "browser" => {
                if !plain || !matches!(url.path(), "" | "/") {
                    return malformed();
                }
                let page = match single_pairs(url).as_deref() {
                    Some([(name, page)]) if name == "url" && page.len() <= MAX_LINK_PAGE_LEN => page.to_owned(),
                    _ => return malformed(),
                };
                let Ok(page) = Url::parse(&page) else { return malformed() };
                if !matches!(page.scheme(), "http" | "https") {
                    return invalid(LinkProblem::NotWeb { scheme: cut(page.scheme(), MAX_SHOWN_ROUTE_LEN) });
                }
                // A page behind a name and password in the address reads as one site and is another.
                if !page.username().is_empty() || page.password().is_some() || page.host_str().is_none() {
                    return malformed();
                }
                // External deep links must never reach loopback, link-local, or private-network endpoints.
                if is_private_or_loopback_host(&page) {
                    return malformed();
                }
                Some(DesktopLink::Browser { url: page.into() })
            }
            _ => invalid(LinkProblem::UnknownRoute { route: cut(host, MAX_SHOWN_ROUTE_LEN) }),
        }
    }
}

/// Links that arrived and the webview has not taken yet: a link that
/// launches the app comes before the webview listens, so it waits here and
/// is taken once, when the webview asks. A few are kept, in order; past
/// that the oldest goes.
#[derive(Default)]
pub struct PendingDesktopLinks(Mutex<VecDeque<DesktopLink>>);

impl PendingDesktopLinks {
    /// Keep `link` for the webview, after any it has not taken.
    pub fn push(&self, link: DesktopLink) {
        let mut queue = self.0.lock().unwrap();
        if queue.len() == MAX_PENDING_LINKS {
            queue.pop_front();
        }
        queue.push_back(link);
    }

    /// The waiting links, oldest first, once: a second take returns none.
    pub fn take(&self) -> Vec<DesktopLink> {
        self.0.lock().unwrap().drain(..).collect()
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
    fn a_settings_link_reaches_the_webview_as_id_and_enable_only() {
        let link = parse(DesktopLinks::Release, "terminalx://settings/general.sounds?enable=1").unwrap();
        assert_eq!(serde_json::to_value(link).unwrap(), serde_json::json!({ "id": "general.sounds", "enable": true }));
    }

    #[test]
    fn a_tab_link_round_trips_in_each_builds_scheme() {
        let session = "01a16ab6-6ed3-7d71-ba73-9cb44606db13";
        let tab = "01a16ab6-6ed3-7d71-ba73-9cc746e1371e";
        for links in [DesktopLinks::Release, DesktopLinks::Dev] {
            let link = links.tab_link_url(session, tab).unwrap();
            assert!(link.starts_with(&format!("{}://tab/", links.scheme())));
            let parsed = links.tab_link(&Url::parse(&link).unwrap()).unwrap();
            assert_eq!(parsed, TabLink { session_id: session.into(), tab_id: tab.into() });
        }
        assert_eq!(DesktopLinks::Release.tab_link(&Url::parse(&format!("terminalx-dev://tab/{session}/{tab}")).unwrap()), None);
        assert_eq!(DesktopLinks::Release.tab_link_url("a/b", tab), None);
    }

    #[test]
    fn tab_links_outside_the_strict_shape_are_rejected() {
        for link in [
            "terminalx://tab/s1",
            "terminalx://tab/s1/t1/extra",
            "terminalx://tab/s1/t1?x=1",
            "terminalx://tab/s1/t1#x",
            "terminalx://user@tab/s1/t1",
            "terminalx://tab:9/s1/t1",
            "terminalx://tab//t1",
            "terminalx://tab/s1/t%201",
            "terminalx://tab/s1/t1/",
            "terminalx://settings/s1/t1",
        ] {
            assert_eq!(DesktopLinks::Release.tab_link(&Url::parse(link).unwrap()), None, "took {link}");
        }
    }

    #[test]
    fn a_tab_link_reaches_the_webview_as_session_and_tab_ids_only() {
        let link = TabLink { session_id: "s1".into(), tab_id: "t1".into() };
        assert_eq!(serde_json::to_value(&link).unwrap(), serde_json::json!({ "sessionId": "s1", "tabId": "t1" }));
    }

    fn route(link: &str) -> Option<DesktopLink> {
        DesktopLinks::Release.route(&Url::parse(link).unwrap())
    }

    fn problem(link: &str) -> LinkProblem {
        match route(link) {
            Some(DesktopLink::Invalid { problem, .. }) => problem,
            other => panic!("{link} was not refused: {other:?}"),
        }
    }

    #[test]
    fn settings_and_tab_links_go_through_the_one_router() {
        assert_eq!(route("terminalx://settings/general.sounds?enable=1"), Some(DesktopLink::Settings(SettingsLink { id: "general.sounds".into(), enable: true })));
        assert_eq!(route("terminalx://tab/s1/t1"), Some(DesktopLink::Tab(TabLink { session_id: "s1".into(), tab_id: "t1".into() })));
        // A known route in the wrong shape is refused as such, not dropped.
        assert_eq!(problem("terminalx://settings/general.sounds?enable=0"), LinkProblem::Malformed { route: "settings".into() });
        assert_eq!(problem("terminalx://tab/s1"), LinkProblem::Malformed { route: "tab".into() });
        // Each kind reaches the webview tagged, with its own fields and nothing else.
        assert_eq!(
            serde_json::to_value(route("terminalx://settings/general.sounds").unwrap()).unwrap(),
            serde_json::json!({ "kind": "settings", "id": "general.sounds", "enable": false })
        );
        assert_eq!(
            serde_json::to_value(route("terminalx://tab/s1/t1").unwrap()).unwrap(),
            serde_json::json!({ "kind": "tab", "sessionId": "s1", "tabId": "t1" })
        );
    }

    #[test]
    fn natively_handled_links_and_other_schemes_never_reach_the_router() {
        for link in [
            "terminalx://auth/callback?code=secret",
            "terminalx://auth/elsewhere?code=secret",
            "terminalx://launch",
            "terminalx://launch/extra",
            "terminalx://join#key",
            "terminalx://join?bad=1",
            "terminalx-dev://session/s1",
            "https://session/s1",
        ] {
            assert_eq!(route(link), None, "routed {link}");
        }
        assert_eq!(DesktopLinks::Dev.route(&Url::parse("terminalx://session/s1").unwrap()), None);
        assert_eq!(
            DesktopLinks::Dev.route(&Url::parse("terminalx-dev://session/s1").unwrap()),
            Some(DesktopLink::Session { session_id: "s1".into() })
        );
    }

    #[test]
    fn a_session_link_names_one_session() {
        let id = "01a16ab6-6ed3-7d71-ba73-9cb44606db13";
        assert_eq!(route(&format!("terminalx://session/{id}")), Some(DesktopLink::Session { session_id: id.into() }));
        assert_eq!(
            serde_json::to_value(route("terminalx://session/s1").unwrap()).unwrap(),
            serde_json::json!({ "kind": "session", "sessionId": "s1" })
        );
        for link in [
            "terminalx://session",
            "terminalx://session/",
            "terminalx://session/s1/",
            "terminalx://session/s1/t1",
            "terminalx://session/s1?tab=t1",
            "terminalx://session/s1#x",
            "terminalx://session/s%201",
            "terminalx://user@session/s1",
            "terminalx://session:9/s1",
        ] {
            assert_eq!(problem(link), LinkProblem::Malformed { route: "session".into() }, "{link}");
        }
        let long = "a".repeat(MAX_TAB_LINK_ID_LEN + 1);
        assert_eq!(problem(&format!("terminalx://session/{long}")), LinkProblem::Malformed { route: "session".into() });
    }

    #[test]
    fn a_new_link_carries_its_project_branch_prompt_and_issue_decoded() {
        assert_eq!(
            route("terminalx://new?project=%2FUsers%2Fme%2Fcode%2Fweb&branch=release%2F1.2&prompt=Fix+the+flaky+test%0Ain+scripts.test.ts"),
            Some(DesktopLink::New {
                project: Some("/Users/me/code/web".into()),
                branch: Some("release/1.2".into()),
                prompt: Some("Fix the flaky test\nin scripts.test.ts".into()),
                linear: None,
            })
        );
        // Order does not matter, and a trailing slash before the query is the same link.
        assert_eq!(
            route("terminalx://new/?prompt=hi&project=/srv/app"),
            Some(DesktopLink::New { project: Some("/srv/app".into()), branch: None, prompt: Some("hi".into()), linear: None })
        );
        // Paragraphs and indented code are prompts like any other.
        assert!(matches!(route("terminalx://new?prompt=one%0A%0Atwo%0A%20%20%20%20code"), Some(DesktopLink::New { .. })));
        assert_eq!(
            route("terminalx://new?linear=pro-130"),
            Some(DesktopLink::New { project: None, branch: None, prompt: None, linear: Some("PRO-130".into()) })
        );
        assert_eq!(
            serde_json::to_value(route("terminalx://new?linear=PRO-7&prompt=also%20this").unwrap()).unwrap(),
            serde_json::json!({ "kind": "new", "project": null, "branch": null, "prompt": "also this", "linear": "PRO-7" })
        );
    }

    #[test]
    fn a_new_link_with_nothing_to_start_or_anything_unexpected_is_refused() {
        let too_long_prompt = format!("terminalx://new?prompt={}", "a".repeat(MAX_LINK_PROMPT_LEN + 1));
        let ideographic_run = format!("terminalx://new?prompt=fix{}delete", "%E3%80%80".repeat(40));
        let too_long_branch = format!("terminalx://new?prompt=x&branch={}", "b".repeat(MAX_LINK_BRANCH_LEN + 1));
        for link in [
            "terminalx://new",
            "terminalx://new?project=/srv/app",
            "terminalx://new?project=/srv/app&branch=main",
            "terminalx://new?prompt=",
            "terminalx://new?prompt=%20%20",
            "terminalx://new?prompt=a&prompt=b",
            "terminalx://new?prompt=a&project=/x&project=/y",
            "terminalx://new?prompt=a&extra=1",
            "terminalx://new?prompt=a%00b",
            "terminalx://new?prompt=a%1Bb",
            // Hidden characters: zero-width space, right-to-left override, BOM, a Unicode tag ("i").
            "terminalx://new?prompt=a%E2%80%8Bb",
            "terminalx://new?prompt=a%E2%80%AEb",
            "terminalx://new?prompt=a%EF%BB%BFb",
            "terminalx://new?prompt=a%F3%A0%81%A9b",
            // Blank space that would push words out of the dialog's view.
            "terminalx://new?prompt=fix%0A%0A%0A%0Adelete+everything",
            "terminalx://new?prompt=fix%0D%0A%0D%0A%0D%0A%0D%0Adelete",
            "terminalx://new?prompt=fix%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20delete",
            // Blank lines and runs made of other blanks: ideographic space, braille blank, line separator.
            "terminalx://new?prompt=fix%0A%E3%80%80%0A%E2%A0%80%0A%C2%A0%0Adelete",
            "terminalx://new?prompt=fix%E2%80%A8delete",
            "terminalx://new?prompt=a&project=relative/path",
            "terminalx://new?prompt=a&project=/srv/../etc",
            "terminalx://new?prompt=a&project=/srv/./app",
            "terminalx://new?prompt=a&project=%2F",
            "terminalx://new?prompt=a&branch=-delete",
            "terminalx://new?prompt=a&branch=a..b",
            "terminalx://new?prompt=a&branch=a%20b",
            "terminalx://new?prompt=a&branch=topic.lock",
            "terminalx://new?prompt=a&branch=a~1",
            "terminalx://new?prompt=a&branch=HEAD@{1}",
            "terminalx://new?prompt=a&branch=/main",
            "terminalx://new?prompt=a&branch=main/",
            "terminalx://new?linear=130",
            "terminalx://new?linear=PRO-",
            "terminalx://new?linear=PRO-0130",
            "terminalx://new?linear=PRO-1-2",
            "terminalx://new?linear=1PRO-2",
            "terminalx://new?linear=PRO-1&linear=PRO-2",
            "terminalx://new/extra?prompt=a",
            "terminalx://new?prompt=a#frag",
            "terminalx://user@new?prompt=a",
            "terminalx://new:80?prompt=a",
            too_long_prompt.as_str(),
            too_long_branch.as_str(),
            ideographic_run.as_str(),
        ] {
            assert_eq!(problem(link), LinkProblem::Malformed { route: "new".into() }, "{link}");
        }
    }

    #[test]
    fn a_browser_link_opens_only_public_web_pages() {
        assert_eq!(route("terminalx://browser?url=https://example.com/a?b=c"), Some(DesktopLink::Browser { url: "https://example.com/a?b=c".into() }));
        assert_eq!(problem("terminalx://browser?url=file:///Users/me/report.html"), LinkProblem::NotWeb { scheme: "file".into() });
        assert_eq!(problem("terminalx://browser?url=javascript:alert(1)"), LinkProblem::NotWeb { scheme: "javascript".into() });
        assert_eq!(problem("terminalx://browser?url=terminalx://session/s1"), LinkProblem::NotWeb { scheme: "terminalx".into() });
        for link in [
            "terminalx://browser",
            "terminalx://browser?url=",
            "terminalx://browser?url=not%20a%20url",
            "terminalx://browser?url=https://a.example&url=https://b.example",
            "terminalx://browser?url=https://a.example&session=s1",
            "terminalx://browser?page=https://a.example",
            "terminalx://browser/extra?url=https://a.example",
            "terminalx://browser?url=https://user:pw@a.example",
            "terminalx://browser?url=https://a.example#x",
            // Loopback and private-network targets must be refused from external deep links (S-40).
            "terminalx://browser?url=http%3A%2F%2Flocalhost%3A61431%2Fo%2Fbilling",
            "terminalx://browser?url=http://127.0.0.1:8080/admin",
            "terminalx://browser?url=http://[::1]:3000/",
            "terminalx://browser?url=http://10.0.0.1/secret",
            "terminalx://browser?url=http://192.168.1.1/",
            "terminalx://browser?url=http://169.254.169.254/latest/meta-data/",
            "terminalx://browser?url=http://printer.local/",
            "terminalx://browser?url=http://host.docker.internal:3000/",
        ] {
            assert_eq!(problem(link), LinkProblem::Malformed { route: "browser".into() }, "{link}");
        }
        let long = format!("terminalx://browser?url=https://a.example/{}", "p".repeat(MAX_LINK_PAGE_LEN));
        assert_eq!(problem(&long), LinkProblem::Malformed { route: "browser".into() });
    }

    #[test]
    fn an_unknown_route_is_named_and_the_link_handed_back_cut_short() {
        assert_eq!(
            route("terminalx://sesion/tx-22"),
            Some(DesktopLink::Invalid { link: "terminalx://sesion/tx-22".into(), problem: LinkProblem::UnknownRoute { route: "sesion".into() } })
        );
        assert_eq!(
            serde_json::to_value(route("terminalx://sesion/tx-22").unwrap()).unwrap(),
            serde_json::json!({ "kind": "invalid", "link": "terminalx://sesion/tx-22", "problem": { "reason": "unknownRoute", "route": "sesion" } })
        );
        assert_eq!(problem("terminalx:nothing"), LinkProblem::UnknownRoute { route: "".into() });
        let long_route = "r".repeat(100);
        assert_eq!(problem(&format!("terminalx://{long_route}")), LinkProblem::UnknownRoute { route: "r".repeat(MAX_SHOWN_ROUTE_LEN) });
        let long = format!("terminalx://elsewhere/{}", "é".repeat(MAX_SHOWN_LINK_LEN));
        let Some(DesktopLink::Invalid { link, .. }) = route(&long) else { panic!("not refused") };
        assert!(link.len() <= MAX_SHOWN_LINK_LEN && Url::parse(&long).unwrap().as_str().starts_with(&link));
    }

    #[test]
    fn pending_links_are_taken_once_in_order_and_only_the_latest_few_are_kept() {
        let pending = PendingDesktopLinks::default();
        assert!(pending.take().is_empty());
        let session = |n: usize| DesktopLink::Session { session_id: format!("s{n}") };
        pending.push(session(0));
        pending.push(session(1));
        assert_eq!(pending.take(), vec![session(0), session(1)]);
        assert!(pending.take().is_empty());
        for n in 0..MAX_PENDING_LINKS + 3 {
            pending.push(session(n));
        }
        assert_eq!(pending.take(), (3..MAX_PENDING_LINKS + 3).map(session).collect::<Vec<_>>());
    }
}
