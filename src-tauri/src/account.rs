//! Optional TerminalX account authentication.
//!
//! OAuth state and every credential stay in the native process. The webview
//! receives only the identity it needs to draw the account surfaces.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use thiserror::Error;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::desktop_links::DesktopLinks;
use crate::keychain::{Keychain, SecretStore};

pub const STATUS_EVENT: &str = "account_status";

/// The server authorizes desktop cloud routes by membership in the path
/// Organization rather than by the active one (PRO-70, CS-17). Without it a
/// desktop reaches only its active Organization, as before.
pub const MULTI_ORG_CAPABILITY: &str = "cloud.desktop.multi-org.v1";

/// The server lists every member Organization's cloud workspaces in one
/// request (`GET /v1/desktop/cloud-catalog`, PRO-74). Without it the desktop
/// lists each Organization on its own.
pub const CATALOG_FEED_CAPABILITY: &str = "cloud.desktop.catalog-feed.v1";

const API_BASE_URL: &str = "https://login.terminalx.ai";
/// Debug builds only: point the account service (and everything built on it,
/// such as cloud workspaces) at a local stack, e.g. terminalx-saas
/// `bun run cloud:local:up` at `http://127.0.0.1:42220`.
pub const DEV_API_BASE_URL_ENV: &str = "TERMINALX_DEV_API_BASE_URL";

/// The account service origin. A release build always uses production; a
/// debug build honors [`DEV_API_BASE_URL_ENV`] when it is an HTTPS origin or
/// a loopback HTTP one.
pub(crate) fn api_base_url() -> String {
    dev_api_base_url(cfg!(debug_assertions), std::env::var(DEV_API_BASE_URL_ENV).ok().as_deref())
        .unwrap_or_else(|| API_BASE_URL.to_string())
}

fn dev_api_base_url(debug_build: bool, value: Option<&str>) -> Option<String> {
    if !debug_build {
        return None;
    }
    let url = Url::parse(value?.trim()).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !allowed || url.path() != "/" || url.query().is_some() || !url.username().is_empty() {
        log::warn!("ignoring {DEV_API_BASE_URL_ENV}: expected an HTTPS or loopback HTTP origin");
        return None;
    }
    Some(url.origin().ascii_serialization())
}
const AUTHORIZE_PATH: &str = "/v1/desktop/auth/authorize";
const SESSION_PATH: &str = "/v1/desktop/auth/session";
const REFRESH_PATH: &str = "/v1/desktop/auth/refresh";
/// The session body (identity, organizations with roles, capabilities) with no
/// tokens: what keeps a role or membership change from waiting for the access
/// token to near its expiry.
const CAPABILITIES_PATH: &str = "/v1/desktop/auth/capabilities";
const LOGOUT_PATH: &str = "/v1/desktop/auth/logout";
const ORGANIZATIONS_PATH: &str = "/v1/desktop/orgs";
const ACTIVE_ORGANIZATION_PATH: &str = "/v1/desktop/auth/org";
const CLIENT_ID: &str = "terminalx-desktop";
const SCOPE: &str = "openid profile email offline_access";
const LOCAL_PROFILE_ID: &str = "local-default";
const KEYCHAIN_ACCOUNT: &str = "desktop-session";
const AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const REFRESH_SKEW_MS: i64 = 60_000;
/// A routine re-read of organizations and roles (window focus) asks the server
/// at most this often.
const ROLES_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// A forced re-read (launch, an explicit refresh, a refusal for lack of role)
/// asks at once, unless an answer arrived this recently: a burst of refusals
/// is one question.
const ROLES_REFRESH_FLOOR: Duration = Duration::from_secs(2);
const REFRESH_NOT_SAVED: &str = "The account session refreshed, but macOS Keychain could not save it.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    state: AccountPhase,
    identity: Option<AccountIdentity>,
    expires_at: Option<i64>,
    last_error: Option<String>,
    context: Option<OnboardingContext>,
    organizations: Vec<OrganizationSummary>,
    /// The server lets this desktop work in every member Organization at once (CS-18).
    multi_org: bool,
    /// The server lists every member Organization in one request (PRO-74).
    catalog_feed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingContext {
    scope: String,
    revision: String,
    /// The signed-in user and profile, without the Organization: what cloud
    /// state belongs to when every member Organization is live (CS-18).
    account: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationSummary {
    pub id: String,
    pub name: String,
    pub role: String,
    /// The user's personal organization (PRO-69); absent from older servers.
    #[serde(default)]
    pub is_personal: bool,
    /// What the cloud offers in this organization (PRO-69); absent from older servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud: Option<OrganizationCloud>,
}

/// What creating an organization did (PRO-16): the organization, and whether
/// it is now the selected one. `selected: false` is "created, not selected":
/// the organization exists and must only be selected, never created again.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationCreated {
    #[serde(flatten)]
    pub organization: OrganizationSummary,
    pub selected: bool,
}

/// Per-organization cloud capabilities, as the desktop session reports them.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationCloud {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub flags: BTreeMap<String, bool>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AccountPhase {
    SignedOut,
    SigningIn,
    SignedIn,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    name: Option<String>,
    email: String,
    organization: Option<String>,
    /// The active (default) organization's id, so the webview need not match by name.
    organization_id: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AccountContext {
    pub access_token: String,
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub profile_id: String,
    pub organization_id: String,
    pub relay_entitled: bool,
    pub generation: u64,
}

/// How a cloud call's Organization was authorized, which decides what keeps
/// its answer current (CS-18).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OrgAccess {
    /// The active Organization, on a server without [`MULTI_ORG_CAPABILITY`]:
    /// the call is stale once the active Organization changes (as before).
    Active,
    /// A member Organization on a server with the capability: the call stays
    /// current while the user is still a member, whatever the default is.
    Member,
}

/// Who the cloud state on this desktop belongs to: the user and profile, and
/// the Organizations it may reach. Cheap to read (no Keychain load or token
/// refresh), so connection watchers can poll it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CloudScope {
    pub user_id: String,
    pub profile_id: String,
    pub active_org_id: String,
    pub multi_org: bool,
    /// Every Organization the user is a member of, the active one included.
    pub members: BTreeSet<String>,
}

impl CloudScope {
    /// Whether a cloud call or connection in `organization_id` is allowed:
    /// the active Organization always; another one only by membership, on a
    /// server with the capability.
    pub fn allows(&self, organization_id: &str) -> bool {
        !organization_id.is_empty()
            && (organization_id == self.active_org_id
                || (self.multi_org && self.members.contains(organization_id)))
    }

    /// The Organizations whose cloud data (keys, outbox, transcript cache)
    /// this desktop keeps: every member Organization, whether or not the
    /// server authorizes by membership right now. Only a lost membership (or
    /// another user) drops an Organization's data; an Organization that is not
    /// reachable (no capability, not the default) keeps it, inactive.
    pub fn kept_orgs(&self) -> BTreeSet<String> {
        let mut kept = self.members.clone();
        if !self.active_org_id.is_empty() {
            kept.insert(self.active_org_id.clone());
        }
        kept
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSession {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    cloud: CloudIdentity,
    #[serde(default)]
    organizations: Vec<Organization>,
    capabilities: Capabilities,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudIdentity {
    cloud_profile_id: String,
    user_id: String,
    email: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    active_org_id: Option<String>,
    #[serde(default)]
    active_org_name: Option<String>,
    linked_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Organization {
    org_id: String,
    name: String,
    role: String,
    #[serde(default)]
    is_personal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cloud: Option<OrganizationCloud>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    #[serde(default)]
    flags: BTreeMap<String, bool>,
    refreshed_at: i64,
}

/// What `POST /v1/desktop/auth/capabilities` answers: a session without tokens.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionBody {
    cloud: CloudIdentity,
    #[serde(default)]
    organizations: Vec<Organization>,
    capabilities: Capabilities,
}

/// The account status after [`AccountManager::refresh_roles`], and whether the
/// server answered for it just now (false when throttled, signed out or unreachable).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolesRefresh {
    status: AccountStatus,
    fresh: bool,
}

struct PendingAuth {
    generation: u64,
    code_verifier: String,
    nonce: String,
    state: String,
    started_at: Instant,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    session: Option<DesktopSession>,
    pending: Option<PendingAuth>,
    signing_in: bool,
    generation: u64,
    last_error: Option<String>,
    /// Sign-outs whose Keychain delete has not answered yet. Until it does
    /// the session is out of memory but may be put back (a refused delete).
    ending: u32,
    /// Counts changes to `session` that the Keychain should follow.
    revision: u64,
    /// The `revision` the Keychain holds.
    stored_revision: u64,
}

impl Inner {
    /// Change the session in memory. The Keychain follows in
    /// [`AccountManager::store`], after the account lock is released.
    fn set_session(&mut self, session: Option<DesktopSession>) {
        self.session = session;
        self.revision = self.revision.wrapping_add(1);
    }
}

/// Why [`AccountManager::store`] failed.
enum StoreError {
    Save(anyhow::Error),
    Delete(anyhow::Error),
}

impl StoreError {
    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Save(error) | Self::Delete(error) => error,
        }
    }
}

#[derive(Default)]
pub struct AccountManager {
    service: OnceLock<String>,
    /// Where status changes are announced. A token refresh can happen inside
    /// any service call (`context()`), not only a status read, so the webview
    /// is told from here whenever what it sees changed.
    app: OnceLock<AppHandle>,
    /// The account as held in memory. Locked only to read or change it, and
    /// never across a Keychain or network call: the main thread and every
    /// cheap read (`current_scope`, `is_current`, ...) take this lock, so
    /// whatever holds it must be done at once.
    inner: Mutex<Inner>,
    /// Where the session is kept between runs: the Keychain, unless a test set another.
    secrets: OnceLock<Arc<dyn SecretStore>>,
    /// Held across a read or write of the stored session, so writes land in
    /// order. Taken before `inner`, never while holding it.
    store_gate: Mutex<()>,
    refresh_gate: Mutex<()>,
    /// When the server last answered with organizations and roles. Held while
    /// asking, so concurrent callers share one answer.
    roles_refreshed: Mutex<Option<Instant>>,
}

enum CallbackAction {
    Ignore,
    Failed,
    Exchange { pending: PendingAuth, code: String },
}

#[derive(Debug, Error)]
enum CloudError {
    #[error("account service returned HTTP {0}")]
    Http(u16),
    #[error("account service request failed")]
    Transport,
    #[error("account service returned an invalid session")]
    InvalidSession,
}

impl AccountManager {
    #[cfg(test)]
    pub(crate) fn set_context_for_test(&self, context: Option<AccountContext>) {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = true;
        inner.generation = context.as_ref().map_or_else(
            || inner.generation.wrapping_add(1),
            |context| context.generation,
        );
        inner.session = context.map(|context| DesktopSession {
            access_token: context.access_token,
            refresh_token: "test-refresh".into(),
            expires_at: 4_000_000_000_000,
            cloud: CloudIdentity {
                cloud_profile_id: context.profile_id,
                user_id: context.user_id,
                email: context.email,
                display_name: Some(context.display_name),
                active_org_id: Some(context.organization_id),
                active_org_name: Some("Test Organization".into()),
                linked_at: 1,
            },
            organizations: vec![],
            capabilities: Capabilities {
                flags: BTreeMap::from([("relay.use".into(), context.relay_entitled)]),
                refreshed_at: 1,
            },
        });
    }

    /// Tests: the member Organizations and whether the server authorizes by membership.
    #[cfg(test)]
    pub(crate) fn set_memberships_for_test(&self, organizations: &[&str], multi_org: bool) {
        let mut inner = self.inner.lock().unwrap();
        let session = inner.session.as_mut().expect("signed in");
        session.organizations = organizations
            .iter()
            .map(|id| Organization { org_id: (*id).into(), name: (*id).into(), role: "member".into(), is_personal: false, cloud: None })
            .collect();
        session.capabilities.flags.insert(MULTI_ORG_CAPABILITY.into(), multi_org);
    }

    /// Tests: whether the server advertises the catalog feed.
    #[cfg(test)]
    pub(crate) fn set_catalog_feed_for_test(&self, offered: bool) {
        let mut inner = self.inner.lock().unwrap();
        inner.session.as_mut().expect("signed in").capabilities.flags.insert(CATALOG_FEED_CAPABILITY.into(), offered);
    }

    /// Tests: another client changed the default (active) Organization.
    #[cfg(test)]
    pub(crate) fn set_active_org_for_test(&self, organization_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.session.as_mut().expect("signed in").cloud.active_org_id = Some(organization_id.into());
    }

    /// Tests: keep the session in `store` instead of the Keychain.
    #[cfg(test)]
    pub(crate) fn use_secrets_for_test(&self, store: Arc<dyn SecretStore>) {
        let _ = self.service.set(TEST_SERVICE.into());
        assert!(self.secrets.set(store).is_ok(), "the store is chosen before its first use");
    }

    /// Tests: sign out on this Mac; true when the Keychain let the session go.
    #[cfg(test)]
    pub(crate) fn sign_out_for_test(&self) -> bool {
        self.end_session().is_some()
    }

    /// Tests: a forced role refresh the server answers with `role` in the
    /// active organization, saved like any other.
    #[cfg(test)]
    pub(crate) fn refresh_roles_for_test(&self, role: &str) -> bool {
        let body = test_session_body(role);
        self.refresh_roles_with(true, Instant::now(), |_| Ok(body))
    }

    pub fn configure(&self, app_identifier: &str) -> Result<()> {
        let wanted = keychain_service_name(app_identifier);
        if let Some(current) = self.service.get() {
            if current == &wanted {
                return Ok(());
            }
            return Err(anyhow!("account service was already configured"));
        }
        self.service
            .set(wanted)
            .map_err(|_| anyhow!("account service was already configured"))
    }

    /// Announce status changes (a silent token refresh with new organizations) to this app.
    pub fn attach_app(&self, app: &AppHandle) {
        let _ = self.app.set(app.clone());
    }

    pub fn status(&self, app: &AppHandle) -> AccountStatus {
        self.attach_app(app);
        self.ensure_loaded();
        self.refresh_if_needed();
        self.snapshot()
    }

    /// Read the organizations, the role in each and the capabilities again
    /// from the account service, so a role or membership changed elsewhere (an
    /// owner demoting this admin) shows here without waiting for the access
    /// token to near its expiry. The answer is saved, so the next launch
    /// starts from it, and announced when it changes what the webview sees.
    ///
    /// A routine call is throttled; `force` asks at once. No token rotates.
    pub fn refresh_roles(&self, app: &AppHandle, force: bool) -> RolesRefresh {
        self.attach_app(app);
        self.ensure_loaded();
        let fresh = self.refresh_roles_with(force, Instant::now(), fetch_session_body);
        RolesRefresh { status: self.snapshot(), fresh }
    }

    /// True when the server answered with the current organizations and roles.
    fn refresh_roles_with(&self, force: bool, now: Instant, fetch: impl FnOnce(&DesktopSession) -> Result<SessionBody, CloudError>) -> bool {
        let (fresh, generation, changed, save_failed) = {
            let mut refreshed = self.roles_refreshed.lock().unwrap();
            // A token rotation brings the same body: nothing more to ask.
            let token = |manager: &Self| manager.inner.lock().unwrap().session.as_ref().map(|session| session.access_token.clone());
            let before = token(self);
            if let Some((generation, changed)) = self.rotate_if_needed() {
                let after = token(self);
                let rotated = after.is_some() && after != before;
                if rotated {
                    *refreshed = Some(now);
                }
                (rotated, generation, changed, Some(REFRESH_NOT_SAVED))
            } else {
                if !roles_refresh_due(*refreshed, now, force) {
                    return false;
                }
                let Some((generation, session)) = ({
                    let inner = self.inner.lock().unwrap();
                    inner.session.clone().map(|session| (inner.generation, session))
                }) else {
                    return false;
                };
                match fetch(&session) {
                    Ok(body) => {
                        let (applied, changed) = self.apply_session_body(generation, &session, body);
                        if applied {
                            *refreshed = Some(now);
                        }
                        // A relaunch that starts from the roles at sign-in is
                        // corrected by its first read: not an error to show.
                        (applied, generation, changed, None)
                    }
                    Err(error) => {
                        // Not a sign-out and not an error to show: the roles shown are
                        // the last known ones, and the token refresh owns expiry.
                        log::debug!("could not refresh TerminalX organizations and roles: {error}");
                        return false;
                    }
                }
            }
        };
        // The Keychain write waits for no lock a caller of this holds: a slow
        // one delays neither the next refresh nor any read of the account.
        self.settle(generation, changed, save_failed);
        fresh
    }

    /// Take a tokenless session body for the session it was asked with.
    /// Returns (applied, what the webview sees changed). A body for another
    /// account, or one that arrives after a sign-out or a token rotation (which
    /// brought a newer body of its own), is dropped. In memory only: the
    /// caller saves it with [`Self::settle`].
    fn apply_session_body(&self, generation: u64, asked_with: &DesktopSession, body: SessionBody) -> (bool, bool) {
        let mut inner = self.inner.lock().unwrap();
        let Some(current) = inner.session.as_ref() else { return (false, false) };
        if inner.generation != generation || current.access_token != asked_with.access_token || current.refresh_token != asked_with.refresh_token {
            return (false, false);
        }
        let candidate = DesktopSession {
            access_token: current.access_token.clone(),
            refresh_token: current.refresh_token.clone(),
            expires_at: current.expires_at,
            cloud: body.cloud,
            organizations: body.organizations,
            capabilities: body.capabilities,
        };
        let Ok(candidate) = normalize_session(candidate) else { return (false, false) };
        if candidate.cloud.user_id != current.cloud.user_id || candidate.cloud.cloud_profile_id != current.cloud.cloud_profile_id {
            return (false, false);
        }
        let before = serde_json::to_value(snapshot(&inner)).ok();
        let stored_changed = serde_json::to_value(&candidate).ok() != serde_json::to_value(current).ok();
        if stored_changed {
            // Saved so a relaunch starts from the current roles, not the ones at sign-in.
            inner.set_session(Some(candidate));
        }
        let changed = serde_json::to_value(snapshot(&inner)).ok() != before;
        (true, changed)
    }

    /// Return a native-only snapshot suitable for account-bound services.
    /// Access tokens never cross the Tauri command boundary.
    pub(crate) fn context(&self) -> Option<AccountContext> {
        self.ensure_loaded();
        self.refresh_if_needed();
        let inner = self.inner.lock().unwrap();
        inner.session.as_ref().map(|session| AccountContext {
            access_token: session.access_token.clone(),
            user_id: session.cloud.user_id.clone(),
            email: session.cloud.email.clone(),
            display_name: session
                .cloud
                .display_name
                .clone()
                .unwrap_or_else(|| session.cloud.email.clone()),
            profile_id: session.cloud.cloud_profile_id.clone(),
            organization_id: session.cloud.active_org_id.clone().unwrap_or_default(),
            relay_entitled: session.capabilities.flags.get("relay.use") == Some(&true),
            generation: inner.generation,
        })
    }

    /// The signed-in user, profile and the Organizations cloud work may
    /// reach, as last loaded, without a Keychain load or token refresh:
    /// cheap enough to poll, and never waiting on either (the account lock
    /// is not held across them).
    pub(crate) fn current_scope(&self) -> Option<CloudScope> {
        let inner = self.inner.lock().unwrap();
        inner.session.as_ref().map(cloud_scope)
    }

    /// [`Self::current_scope`] for whoever drops what a previous identity
    /// left behind (connections, keys, the outbox, the transcript cache):
    /// `None` while a sign-out waits for the Keychain, because the session
    /// is then out of memory but comes back if the Keychain refuses. Nothing
    /// is dropped until the sign-out is confirmed. Read in one step with the
    /// outcome, so a refused sign-out is never seen as signed out.
    pub(crate) fn settled_scope(&self) -> Option<Option<CloudScope>> {
        let inner = self.inner.lock().unwrap();
        (inner.ending == 0).then(|| inner.session.as_ref().map(cloud_scope))
    }

    /// The context for a cloud call in `organization_id` (CS-18). The active
    /// Organization is always allowed; another one only when the server
    /// authorizes by membership and the user is a member. The access says
    /// what keeps the answer current (see [`Self::is_current_in`]).
    pub(crate) fn context_in(&self, organization_id: &str) -> Result<(AccountContext, OrgAccess), &'static str> {
        let mut context = self.context().ok_or("account_signed_out")?;
        let scope = self.current_scope().ok_or("account_signed_out")?;
        if scope.user_id != context.user_id || !scope.allows(organization_id) {
            return Err("cloud_organization_unavailable");
        }
        context.organization_id = organization_id.to_string();
        Ok((context, if scope.multi_org { OrgAccess::Member } else { OrgAccess::Active }))
    }

    /// [`Self::is_current`] for a context from [`Self::context_in`]: a
    /// member Organization's answer stays current across a change of the
    /// default Organization, and is fenced by the account and the membership.
    pub(crate) fn is_current_in(&self, context: &AccountContext, access: OrgAccess) -> bool {
        match access {
            OrgAccess::Active => self.is_current(context),
            OrgAccess::Member => {
                let inner = self.inner.lock().unwrap();
                inner.generation == context.generation
                    && inner.session.as_ref().is_some_and(|session| {
                        let scope = cloud_scope(session);
                        scope.user_id == context.user_id
                            && scope.profile_id == context.profile_id
                            && scope.multi_org
                            && scope.allows(&context.organization_id)
                    })
            }
        }
    }

    /// Whether the server offers the cross-organization catalog feed (PRO-74).
    pub(crate) fn catalog_feed(&self) -> bool {
        self.inner.lock().unwrap().session.as_ref().is_some_and(catalog_feed)
    }

    /// For an answer that spans Organizations (the catalog feed): the scope of
    /// now, if the account that asked is still the one signed in. The caller
    /// keeps only the Organizations this scope allows.
    pub(crate) fn scope_if_same_account(&self, context: &AccountContext) -> Option<CloudScope> {
        let inner = self.inner.lock().unwrap();
        if inner.generation != context.generation {
            return None;
        }
        let scope = cloud_scope(inner.session.as_ref()?);
        (scope.user_id == context.user_id && scope.profile_id == context.profile_id).then_some(scope)
    }

    /// Fence native service responses against sign-out or account replacement.
    /// A request may finish after either event, but its Organization data must
    /// never be returned to the webview in the new account generation.
    pub(crate) fn is_current(&self, context: &AccountContext) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.generation == context.generation
            && inner.session.as_ref().is_some_and(|session| {
                session.cloud.user_id == context.user_id
                    && session.cloud.cloud_profile_id == context.profile_id
                    && session.cloud.active_org_id.as_deref().unwrap_or_default()
                        == context.organization_id
            })
    }

    /// The signed-in user and the webview's context revision, as last loaded,
    /// without a Keychain load or token refresh. Writes of per-user files are
    /// fenced by the revision so a late write never lands in the next account.
    pub(crate) fn current_revision(&self) -> Option<(String, String)> {
        let inner = self.inner.lock().unwrap();
        inner.session.as_ref().map(|session| {
            let scope = context_scope(&session.cloud.user_id, &session.cloud.cloud_profile_id, session.cloud.active_org_id.as_deref().unwrap_or_default());
            (session.cloud.user_id.clone(), format!("{scope}:{}", inner.generation))
        })
    }

    pub(crate) fn context_revision(context: &AccountContext) -> String {
        format!("{}:{}", context_scope(&context.user_id, &context.profile_id, &context.organization_id), context.generation)
    }

    /// Create an organization with a caller-owned idempotency key, then select
    /// it through the server-authoritative profile endpoint. The key is never
    /// persisted in the account session and is safe to reuse after a timeout.
    /// A create whose selection failed is still a create: it is returned with
    /// `selected: false`, so the caller keeps the organization's id and only
    /// selects it next time (PRO-16).
    pub(crate) fn create_organization(
        &self,
        name: &str,
        idempotency_key: &str,
    ) -> Result<OrganizationCreated> {
        let context = self
            .context()
            .ok_or_else(|| anyhow!("account is signed out"))?;
        let name = name.trim();
        if name.is_empty() || idempotency_key.trim().is_empty() {
            return Err(anyhow!("organization name and idempotency key are required"));
        }
        let organization: OrganizationSummary = post_authenticated(
            ORGANIZATIONS_PATH,
            json!({ "name": name }),
            Some(&context.access_token),
            Some(idempotency_key),
        )?;
        // Why it failed stays in the log: the interface says what to do next.
        let selected = match self.select_organization(&organization.id, &context) {
            Ok(()) => true,
            Err(error) => {
                log::warn!("created organization {} but could not select it: {error:#}", organization.id);
                false
            }
        };
        Ok(OrganizationCreated { organization, selected })
    }

    fn select_organization(&self, organization_id: &str, context: &AccountContext) -> Result<()> {
        #[derive(Deserialize)]
        struct SelectionBody {
            cloud: CloudIdentity,
            #[serde(default)]
            organizations: Vec<Organization>,
        }
        let body: SelectionBody = post_authenticated(
            ACTIVE_ORGANIZATION_PATH,
            json!({ "orgId": organization_id }),
            Some(&context.access_token),
            None,
        )?;
        if !selection_matches(organization_id, body.cloud.active_org_id.as_deref()) {
            return Err(anyhow!("account service selected a different organization"));
        }
        {
            let mut inner = self.inner.lock().unwrap();
            let current = inner.session.as_ref();
            if inner.generation != context.generation
                || current.map(|session| session.cloud.user_id.as_str()) != Some(context.user_id.as_str())
                || current.map(|session| session.cloud.cloud_profile_id.as_str()) != Some(context.profile_id.as_str())
                || current.and_then(|session| session.cloud.active_org_id.as_deref())
                    != (!context.organization_id.is_empty()).then_some(context.organization_id.as_str())
            {
                return Err(anyhow!("account context changed while selecting organization"));
            }
            let mut session = inner.session.clone().ok_or_else(|| anyhow!("account is signed out"))?;
            session.cloud.active_org_id = body.cloud.active_org_id;
            session.cloud.active_org_name = body.cloud.active_org_name;
            if !body.organizations.is_empty() {
                session.organizations = body.organizations;
            }
            inner.set_session(Some(session));
        }
        self.store().map_err(StoreError::into_error).context("save selected organization")
    }

    pub(crate) fn select_organization_for_revision(&self, organization_id: &str, revision: &str) -> Result<()> {
        let context = self.context().ok_or_else(|| anyhow!("account is signed out"))?;
        if Self::context_revision(&context) != revision { return Err(anyhow!("account context changed")); }
        self.select_organization(organization_id, &context)
    }

    pub fn begin_sign_in(self: &Arc<Self>, app: &AppHandle) -> Result<AccountStatus> {
        self.ensure_loaded();
        {
            let inner = self.inner.lock().unwrap();
            if inner.session.is_some() {
                return Ok(snapshot(&inner));
            }
        }

        let pending = PendingAuth {
            generation: 0,
            code_verifier: random_url_token(),
            nonce: random_url_token(),
            state: random_url_token(),
            started_at: Instant::now(),
        };
        let links = DesktopLinks::for_identifier(&app.config().identifier);
        let authorize_url = authorize_url(&pending, links)?;
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation = inner.generation.wrapping_add(1);
            let generation = inner.generation;
            inner.pending = Some(PendingAuth {
                generation,
                ..pending
            });
            inner.signing_in = true;
            inner.last_error = None;
            generation
        };

        if let Err(error) = app.opener().open_url(authorize_url.as_str(), None::<&str>) {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation == generation {
                inner.pending = None;
                inner.signing_in = false;
                inner.last_error = Some("The sign-in page could not be opened.".into());
            }
            return Err(error).context("open the TerminalX sign-in page");
        }

        let manager = self.clone();
        let timeout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AUTH_TIMEOUT).await;
            let expired = {
                let mut inner = manager.inner.lock().unwrap();
                let current = inner.pending.as_ref().map(|pending| pending.generation);
                if current == Some(generation) {
                    inner.pending = None;
                    inner.signing_in = false;
                    inner.last_error = Some("Sign-in timed out. Try again.".into());
                    true
                } else {
                    false
                }
            };
            if expired {
                manager.emit(&timeout_app);
            }
        });

        let status = self.snapshot();
        self.emit(app);
        Ok(status)
    }

    pub fn sign_out(&self, app: &AppHandle) -> AccountStatus {
        self.ensure_loaded();
        let session = self.end_session();
        let status = self.snapshot();
        self.emit(app);

        if let Some(session) = session {
            if let Err(error) = logout(&session) {
                log::debug!("TerminalX account logout request failed: {error}");
            }
        }
        status
    }

    /// Sign out on this Mac: at once in memory (everything made for the
    /// account is fenced by the new generation), then in the Keychain.
    /// Returns the session that ended, for the server to be told. When the
    /// Keychain keeps the session it is still signed in, as the next launch
    /// would find: the session is put back and nothing is returned.
    fn end_session(&self) -> Option<DesktopSession> {
        let (generation, session) = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation = inner.generation.wrapping_add(1);
            inner.pending = None;
            inner.signing_in = false;
            inner.last_error = None;
            let session = inner.session.take();
            // Counted even with no session in memory: one that could not be
            // read is removed too. Out of memory from here, so a save or a
            // refresh that is under way writes nothing of it back.
            inner.set_session(None);
            // Not confirmed until the Keychain answers (see `settled_scope`).
            inner.ending += 1;
            (inner.generation, session)
        };
        let stored = self.store();
        let mut inner = self.inner.lock().unwrap();
        // With the outcome, in one step: confirmed, or put back just below.
        inner.ending -= 1;
        let Err(error) = stored else { return session };
        log::warn!("could not remove TerminalX account session from Keychain: {:#}", error.into_error());
        // A sign-in begun meanwhile owns the account now.
        if inner.generation == generation {
            inner.last_error = Some("Sign-out could not remove the account session from macOS Keychain.".into());
            if inner.session.is_none() && session.is_some() {
                inner.set_session(session);
            }
        }
        None
    }

    pub fn handle_deep_link(self: &Arc<Self>, app: &AppHandle, url: &Url) -> bool {
        let links = DesktopLinks::for_identifier(&app.config().identifier);
        if !links.is_auth_callback(url) {
            return false;
        }
        let action = self.claim_callback(url);
        match action {
            CallbackAction::Ignore => {}
            CallbackAction::Failed => self.emit(app),
            CallbackAction::Exchange { pending, code } => {
                let manager = self.clone();
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let outcome = exchange_code(&pending, &code, links);
                    manager.finish_exchange(&app, pending.generation, outcome);
                });
            }
        }
        true
    }

    fn claim_callback(&self, url: &Url) -> CallbackAction {
        let returned_state = url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()));
        let mut inner = self.inner.lock().unwrap();
        let Some(expected) = inner.pending.as_ref() else {
            return CallbackAction::Ignore;
        };
        if returned_state.as_deref() != Some(expected.state.as_str()) {
            return CallbackAction::Ignore;
        }

        let pending = inner
            .pending
            .take()
            .expect("pending authentication disappeared");
        if pending.started_at.elapsed() > AUTH_TIMEOUT {
            inner.signing_in = false;
            inner.last_error = Some("That sign-in link expired. Try again.".into());
            return CallbackAction::Failed;
        }
        if url.query_pairs().any(|(key, _)| key == "error") {
            inner.signing_in = false;
            inner.last_error = Some("Sign-in was cancelled.".into());
            return CallbackAction::Failed;
        }
        let code = url
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then(|| value.into_owned()));
        let Some(code) = code.filter(|code| !code.trim().is_empty()) else {
            inner.signing_in = false;
            inner.last_error = Some("The sign-in response was incomplete. Try again.".into());
            return CallbackAction::Failed;
        };
        CallbackAction::Exchange { pending, code }
    }

    fn finish_exchange(
        &self,
        app: &AppHandle,
        generation: u64,
        outcome: Result<DesktopSession, CloudError>,
    ) {
        if !self.apply_exchange(generation, outcome) {
            return;
        }
        // Signed in as soon as the exchange answers; the Keychain follows.
        self.emit(app);
        if self.persist(generation, Some("Signed in for this run, but macOS Keychain could not save the session.")) {
            self.emit(app);
        }
    }

    /// Take a sign-in's outcome, in memory. False when the sign-in it belongs
    /// to is no longer the pending one.
    fn apply_exchange(&self, generation: u64, outcome: Result<DesktopSession, CloudError>) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || !inner.signing_in {
            return false;
        }
        inner.signing_in = false;
        match outcome {
            Ok(session) => {
                inner.last_error = None;
                inner.set_session(Some(session));
            }
            Err(error) => {
                inner.last_error = Some(friendly_cloud_error(&error));
            }
        }
        true
    }

    /// Take a refresh's outcome, in memory; true when what the webview sees
    /// changed (organizations and their cloud capabilities, identity,
    /// sign-out, the error, or the expiry the webview schedules its own
    /// refresh from). The caller stores it with [`Self::settle`].
    fn apply_refresh(&self, generation: u64, session: &DesktopSession, result: Result<DesktopSession, CloudError>) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let before = serde_json::to_value(snapshot(&inner)).ok();
        let unchanged = inner.generation == generation
            && inner
                .session
                .as_ref()
                .map(|current| current.refresh_token.as_str())
                == Some(session.refresh_token.as_str());
        if !unchanged {
            return false;
        }

        match result {
            Ok(refreshed) => {
                inner.last_error = None;
                inner.set_session(Some(refreshed));
            }
            Err(CloudError::Http(400 | 401 | 403)) => {
                inner.set_session(None);
                inner.last_error = Some("Your TerminalX session expired. Sign in again.".into());
            }
            Err(error) => {
                inner.last_error = Some(friendly_cloud_error(&error));
            }
        }
        serde_json::to_value(snapshot(&inner)).ok() != before
    }

    /// Rotate the tokens when they are about to expire; true when it asked.
    fn refresh_if_needed(&self) -> bool {
        let Some((generation, changed)) = self.rotate_if_needed() else { return false };
        self.settle(generation, changed, Some(REFRESH_NOT_SAVED));
        true
    }

    /// Ask for new tokens when the held ones are about to expire and take the
    /// answer in memory. Returns the generation it was asked for and whether
    /// what the webview sees changed; the caller stores it with
    /// [`Self::settle`] once it holds no lock.
    fn rotate_if_needed(&self) -> Option<(u64, bool)> {
        // Refresh tokens rotate. Serializing this section prevents two status
        // reads from submitting the same token family at once.
        let _gate = self.refresh_gate.lock().unwrap();
        let (generation, session) = {
            let inner = self.inner.lock().unwrap();
            inner.session.as_ref().and_then(|session| {
                should_refresh(session.expires_at, now_ms())
                    .then(|| (inner.generation, session.clone()))
            })
        }?;
        let result = refresh(&session);
        Some((generation, self.apply_refresh(generation, &session, result)))
    }

    /// After a change made in memory for `generation`: announce it, then
    /// bring the Keychain up to date. `save_failed` is what to show when the
    /// session could not be saved.
    fn settle(&self, generation: u64, changed: bool, save_failed: Option<&'static str>) {
        let announce = || {
            if let Some(app) = self.app.get() {
                self.emit(app);
            }
        };
        if changed {
            announce();
        }
        if self.persist(generation, save_failed) {
            announce();
        }
    }

    /// Bring the Keychain up to date with the session in memory. True when a
    /// failure changed what the webview sees: `save_failed` is shown when the
    /// session could not be saved and `generation` is still the account's.
    fn persist(&self, generation: u64, save_failed: Option<&'static str>) -> bool {
        match self.store() {
            Ok(()) => false,
            Err(StoreError::Delete(error)) => {
                log::warn!("could not remove the TerminalX account session from Keychain: {error:#}");
                false
            }
            Err(StoreError::Save(error)) => {
                log::warn!("could not save the TerminalX account session to Keychain: {error:#}");
                let Some(message) = save_failed else { return false };
                let mut inner = self.inner.lock().unwrap();
                if inner.generation != generation || inner.session.is_none() {
                    return false;
                }
                let changed = inner.last_error.as_deref() != Some(message);
                inner.last_error = Some(message.into());
                changed
            }
        }
    }

    /// Write the session as it is in memory now to the Keychain (or remove it
    /// when signed out), unless the Keychain already has it.
    ///
    /// Every change to the session is made in memory first, under the account
    /// lock, and then stored from here with that lock released, so a Keychain
    /// call that is slow or never returns holds up nothing that reads the
    /// account. Writes are made one at a time and each writes the newest
    /// session rather than the one its caller made: a write that was waiting
    /// behind a slow one can therefore never put an older session back, or
    /// bring back one that was signed out meanwhile.
    fn store(&self) -> Result<(), StoreError> {
        let _store = self.store_gate.lock().unwrap_or_else(PoisonError::into_inner);
        let (revision, session) = {
            let inner = self.inner.lock().unwrap();
            if inner.stored_revision == inner.revision {
                return Ok(());
            }
            (inner.revision, inner.session.clone())
        };
        match &session {
            Some(session) => self.save_session(session).map_err(StoreError::Save)?,
            None => self.delete_session().map_err(StoreError::Delete)?,
        }
        self.inner.lock().unwrap().stored_revision = revision;
        Ok(())
    }

    fn ensure_loaded(&self) {
        if self.inner.lock().unwrap().loaded {
            return;
        }
        // Read with the account lock released: until the Keychain answers the
        // account reads as not loaded (signed out), it does not wait.
        let _store = self.store_gate.lock().unwrap_or_else(PoisonError::into_inner);
        if self.inner.lock().unwrap().loaded {
            return;
        }
        let stored = self.load_session();
        let mut inner = self.inner.lock().unwrap();
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        match stored {
            // Nothing changes the session before it is loaded; if something
            // did, that is newer than what was stored.
            Ok(session) if inner.revision == 0 => inner.session = session,
            Ok(_) => {}
            Err(error) => {
                log::warn!("could not read TerminalX account session from Keychain: {error:#}");
                inner.last_error = Some(
                    "The saved TerminalX account session could not be read from macOS Keychain."
                        .into(),
                );
            }
        }
    }

    fn snapshot(&self) -> AccountStatus {
        snapshot(&self.inner.lock().unwrap())
    }

    /// The active organization's name, for a native dialog that must say
    /// which organization something is about to be shared with. `None` when
    /// `organization_id` is not the active one or its name is not known.
    pub(crate) fn active_organization_name(&self, organization_id: &str) -> Option<String> {
        let identity = self.snapshot().identity?;
        (identity.organization_id.as_deref() == Some(organization_id)).then_some(identity.organization).flatten().filter(|name| !name.trim().is_empty())
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit(STATUS_EVENT, self.snapshot());
    }

    fn service(&self) -> Result<&str> {
        self.service
            .get()
            .map(String::as_str)
            .ok_or_else(|| anyhow!("account service is not configured"))
    }

    fn secrets(&self) -> &dyn SecretStore {
        self.secrets.get_or_init(|| Arc::new(Keychain)).as_ref()
    }

    /// Callers hold `store_gate` and not the account lock.
    fn load_session(&self) -> Result<Option<DesktopSession>> {
        let Some(bytes) = self.secrets().get(self.service()?, KEYCHAIN_ACCOUNT).context("read account session from Keychain")? else {
            return Ok(None);
        };
        let bytes = Zeroizing::new(bytes);
        let session = serde_json::from_slice(bytes.as_slice())
            .context("decode account session from Keychain")?;
        normalize_session(session)
            .map(Some)
            .map_err(anyhow::Error::from)
    }

    /// Callers hold `store_gate` and not the account lock.
    fn save_session(&self, session: &DesktopSession) -> Result<()> {
        let bytes = Zeroizing::new(serde_json::to_vec(session).context("encode account session")?);
        self.secrets()
            .set(self.service()?, KEYCHAIN_ACCOUNT, bytes.as_slice())
            .context("save account session to Keychain")
    }

    /// Callers hold `store_gate` and not the account lock.
    fn delete_session(&self) -> Result<()> {
        self.secrets().delete(self.service()?, KEYCHAIN_ACCOUNT).context("delete account session from Keychain")
    }
}

const DEV_KEYCHAIN_SERVICE_ENV: &str = "RACCOON_DEV_KEYCHAIN_SERVICE";

/// A debug build's own Keychain service, from `RACCOON_DEV_KEYCHAIN_SERVICE`:
/// two development instances on one Mac give themselves different ones, so
/// neither reads or overwrites the other's secrets. Release builds have none.
pub(crate) fn dev_keychain_service() -> Option<String> {
    dev_keychain_service_from(cfg!(debug_assertions), std::env::var(DEV_KEYCHAIN_SERVICE_ENV).ok().as_deref())
}

fn dev_keychain_service_from(debug_build: bool, value: Option<&str>) -> Option<String> {
    if !debug_build {
        return None;
    }
    let value = value?.trim();
    (value.starts_with("dev.terminalx.") && value.len() <= 120).then(|| value.to_owned())
}

fn keychain_service_name(app_identifier: &str) -> String {
    dev_keychain_service().unwrap_or_else(|| format!("{app_identifier}.account"))
}

fn selection_matches(requested: &str, selected: Option<&str>) -> bool {
    !requested.is_empty() && selected == Some(requested)
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn snapshot(inner: &Inner) -> AccountStatus {
    let (state, identity, expires_at) = if let Some(session) = inner.session.as_ref() {
        (
            AccountPhase::SignedIn,
            Some(AccountIdentity {
                name: session.cloud.display_name.clone(),
                email: session.cloud.email.clone(),
                organization: session.cloud.active_org_name.clone(),
                organization_id: session.cloud.active_org_id.clone(),
            }),
            Some(session.expires_at),
        )
    } else if inner.signing_in {
        (AccountPhase::SigningIn, None, None)
    } else {
        (AccountPhase::SignedOut, None, None)
    };
    AccountStatus {
        state,
        identity,
        expires_at,
        last_error: inner.last_error.clone(),
        context: inner.session.as_ref().map(|session| {
            let scope = context_scope(&session.cloud.user_id, &session.cloud.cloud_profile_id, session.cloud.active_org_id.as_deref().unwrap_or_default());
            let account = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&session.cloud.user_id, &session.cloud.cloud_profile_id)).expect("serialize account")));
            OnboardingContext { revision: format!("{scope}:{}", inner.generation), scope, account }
        }),
        organizations: inner.session.as_ref().map(|session| session.organizations.iter().map(|org| OrganizationSummary { id: org.org_id.clone(), name: org.name.clone(), role: org.role.clone(), is_personal: org.is_personal, cloud: org.cloud.clone() }).collect()).unwrap_or_default(),
        multi_org: inner.session.as_ref().is_some_and(multi_org),
        catalog_feed: inner.session.as_ref().is_some_and(catalog_feed),
    }
}

/// The feed spans Organizations, so it is only used where the server also
/// authorizes by membership.
fn catalog_feed(session: &DesktopSession) -> bool {
    multi_org(session) && session.capabilities.flags.get(CATALOG_FEED_CAPABILITY) == Some(&true)
}

fn multi_org(session: &DesktopSession) -> bool {
    session.capabilities.flags.get(MULTI_ORG_CAPABILITY) == Some(&true)
}

fn cloud_scope(session: &DesktopSession) -> CloudScope {
    let active_org_id = session.cloud.active_org_id.clone().unwrap_or_default();
    let mut members: BTreeSet<String> = session.organizations.iter().map(|org| org.org_id.clone()).filter(|id| !id.is_empty()).collect();
    if !active_org_id.is_empty() {
        members.insert(active_org_id.clone());
    }
    CloudScope {
        user_id: session.cloud.user_id.clone(),
        profile_id: session.cloud.cloud_profile_id.clone(),
        active_org_id,
        multi_org: multi_org(session),
        members,
    }
}

fn context_scope(user: &str, profile: &str, organization: &str) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(&(user, profile, organization)).expect("serialize context")))
}

fn random_url_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn code_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(pending: &PendingAuth, links: DesktopLinks) -> Result<Url> {
    let mut url = Url::parse(&format!("{}{AUTHORIZE_PATH}", api_base_url()))?;
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", links.redirect_uri())
        .append_pair("scope", SCOPE)
        .append_pair("nonce", &pending.nonce)
        .append_pair("state", &pending.state)
        .append_pair("code_challenge", &code_challenge(&pending.code_verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("local_profile_id", LOCAL_PROFILE_ID);
    if links == DesktopLinks::Dev {
        url.query_pairs_mut().append_pair("app", "dev");
    }
    Ok(url)
}

fn endpoint(path: &str) -> String {
    format!("{}{path}", api_base_url())
}

fn exchange_code(pending: &PendingAuth, code: &str, links: DesktopLinks) -> Result<DesktopSession, CloudError> {
    post_json(
        SESSION_PATH,
        json!({
            "code": code,
            "codeVerifier": pending.code_verifier,
            "nonce": pending.nonce,
            "redirectUri": links.redirect_uri(),
            "state": pending.state,
            "localProfileId": LOCAL_PROFILE_ID,
        }),
        None,
    )
    .and_then(normalize_session)
}

fn refresh(session: &DesktopSession) -> Result<DesktopSession, CloudError> {
    post_json(
        REFRESH_PATH,
        json!({ "refreshToken": session.refresh_token }),
        None,
    )
    .and_then(normalize_session)
}

fn fetch_session_body(session: &DesktopSession) -> Result<SessionBody, CloudError> {
    post_json(CAPABILITIES_PATH, json!({}), Some(&session.access_token))
}

/// Whether to ask the server for organizations and roles now.
fn roles_refresh_due(last: Option<Instant>, now: Instant, force: bool) -> bool {
    let Some(last) = last else { return true };
    now.saturating_duration_since(last) >= if force { ROLES_REFRESH_FLOOR } else { ROLES_REFRESH_INTERVAL }
}

fn logout(session: &DesktopSession) -> Result<(), CloudError> {
    post_json::<serde_json::Value>(
        LOGOUT_PATH,
        json!({ "refreshToken": session.refresh_token }),
        Some(&session.access_token),
    )
    .map(|_| ())
}

fn post_json<T: DeserializeOwned>(
    path: &str,
    body: serde_json::Value,
    access_token: Option<&str>,
) -> Result<T, CloudError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .redirects(0)
        .build();
    let mut request = agent
        .post(&endpoint(path))
        .set("content-type", "application/json");
    if let Some(token) = access_token {
        request = request.set("authorization", &format!("Bearer {token}"));
    }
    let response = match request.send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => return Err(CloudError::Http(status)),
        Err(ureq::Error::Transport(_)) => return Err(CloudError::Transport),
    };
    let value = response
        .into_json::<T>()
        .map_err(|_| CloudError::InvalidSession)?;
    Ok(value)
}

fn post_authenticated<T: DeserializeOwned>(
    path: &str,
    body: serde_json::Value,
    access_token: Option<&str>,
    idempotency_key: Option<&str>,
) -> Result<T, anyhow::Error> {
    let agent = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .redirects(0)
        .build();
    let mut request = agent
        .post(&endpoint(path))
        .set("content-type", "application/json");
    if let Some(token) = access_token {
        request = request.set("authorization", &format!("Bearer {token}"));
    }
    if let Some(key) = idempotency_key {
        request = request.set("Idempotency-Key", key);
    }
    let response = request
        .send_json(body)
        .map_err(|error| anyhow!("account service request failed: {error}"))?;
    response
        .into_json::<T>()
        .map_err(|error| anyhow!("account service returned invalid JSON: {error}"))
}

fn normalize_session(mut session: DesktopSession) -> Result<DesktopSession, CloudError> {
    session.access_token = session.access_token.trim().into();
    session.refresh_token = session.refresh_token.trim().into();
    session.cloud.cloud_profile_id = session.cloud.cloud_profile_id.trim().into();
    session.cloud.user_id = session.cloud.user_id.trim().into();
    session.cloud.email = session.cloud.email.trim().into();
    session.cloud.display_name = trimmed(session.cloud.display_name);
    session.cloud.active_org_id = trimmed(session.cloud.active_org_id);
    session.cloud.active_org_name = trimmed(session.cloud.active_org_name);
    for organization in &mut session.organizations {
        organization.org_id = organization.org_id.trim().into();
        organization.name = organization.name.trim().into();
        organization.role = organization.role.trim().into();
    }
    let invalid = session.access_token.is_empty()
        || session.refresh_token.is_empty()
        || session.expires_at <= 0
        || session.cloud.cloud_profile_id.is_empty()
        || session.cloud.user_id.is_empty()
        || session.cloud.email.is_empty()
        || session.cloud.linked_at <= 0
        || session.capabilities.refreshed_at <= 0
        || session
            .organizations
            .iter()
            .any(|organization| organization.org_id.is_empty() || organization.name.is_empty());
    if invalid {
        return Err(CloudError::InvalidSession);
    }
    Ok(session)
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn friendly_cloud_error(error: &CloudError) -> String {
    match error {
        CloudError::Http(400) => "That sign-in link was invalid or expired. Try again.".into(),
        CloudError::Http(401 | 403) => {
            "TerminalX could not authorize this account. Try signing in again.".into()
        }
        CloudError::Http(_) | CloudError::Transport => {
            "TerminalX could not reach the account service. Try again.".into()
        }
        CloudError::InvalidSession => "The account service returned an invalid session.".into(),
    }
}

#[cfg(test)]
pub(crate) const TEST_SERVICE: &str = "test.terminalx.account";

#[cfg(test)]
fn test_session_body(role: &str) -> SessionBody {
    serde_json::from_value(json!({
        "cloud": { "cloudProfileId": "profile", "userId": "user", "email": "a@example.com", "displayName": "A", "activeOrgId": "org-a", "activeOrgName": "Test Organization", "linkedAt": 1 },
        "organizations": [{ "orgId": "org-a", "name": "Acme", "role": role, "isPersonal": false, "cloud": { "enabled": true, "flags": {} } }],
        "capabilities": { "flags": { MULTI_ORG_CAPABILITY: true }, "refreshedAt": 5 }
    }))
    .unwrap()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn should_refresh(expires_at: i64, now: i64) -> bool {
    expires_at <= now + REFRESH_SKEW_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_created_organization_says_whether_it_was_selected() {
        let organization = OrganizationSummary { id: "org-1".into(), name: "Team".into(), role: "owner".into(), is_personal: false, cloud: None };
        let unselected = OrganizationCreated { organization: organization.clone(), selected: false };
        assert_eq!(
            serde_json::to_value(&unselected).unwrap(),
            serde_json::json!({ "id": "org-1", "name": "Team", "role": "owner", "isPersonal": false, "selected": false })
        );
        let selected = OrganizationCreated { organization, selected: true };
        assert_eq!(serde_json::to_value(&selected).unwrap()["selected"], true);
    }

    fn pending() -> PendingAuth {
        PendingAuth {
            generation: 7,
            code_verifier: "a".repeat(64),
            nonce: "nonce-value".into(),
            state: "state-value".into(),
            started_at: Instant::now(),
        }
    }

    #[test]
    fn authorize_url_matches_the_deployed_desktop_contract() {
        let pending = pending();
        let url = authorize_url(&pending, DesktopLinks::Release).unwrap();
        let params: BTreeMap<_, _> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();

        assert_eq!(
            url.as_str().split('?').next(),
            Some("https://login.terminalx.ai/v1/desktop/auth/authorize")
        );
        assert_eq!(
            params.get("client_id").map(String::as_str),
            Some("terminalx-desktop")
        );
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some("terminalx://auth/callback")
        );
        assert_eq!(params.get("scope").map(String::as_str), Some(SCOPE));
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some(code_challenge(&pending.code_verifier).as_str())
        );
        assert_eq!(
            params.get("local_profile_id").map(String::as_str),
            Some("local-default")
        );
    }

    #[test]
    fn authorize_url_selects_the_build_redirect_and_only_requests_dev_for_dev() {
        for links in [DesktopLinks::Release, DesktopLinks::Dev] {
            let url = authorize_url(&pending(), links).unwrap();
            let params: BTreeMap<_, _> = url.query_pairs().collect();
            assert_eq!(params.get("redirect_uri").map(|v| v.as_ref()), Some(links.redirect_uri()));
            assert_eq!(params.get("app").map(|v| v.as_ref()), (links == DesktopLinks::Dev).then_some("dev"));
            assert!(!params.contains_key("legacy"));
        }
    }

    #[test]
    fn recognizes_only_the_expected_account_callback() {
        assert!(DesktopLinks::Release.is_auth_callback(
            &Url::parse("terminalx://auth/callback?code=secret&state=state").unwrap()
        ));
        assert!(!DesktopLinks::Release.is_auth_callback(
            &Url::parse("terminalx://launch?code=secret&state=state").unwrap()
        ));
        assert!(!DesktopLinks::Release.is_auth_callback(
            &Url::parse("https://auth/callback?code=secret&state=state").unwrap()
        ));
        assert!(DesktopLinks::Release.is_launch_link(&Url::parse("terminalx://launch").unwrap()));
    }

    #[test]
    fn ignores_a_callback_that_does_not_match_the_pending_state() {
        let manager = AccountManager::default();
        manager.inner.lock().unwrap().pending = Some(pending());

        let action = manager.claim_callback(
            &Url::parse("terminalx://auth/callback?code=one-time-code&state=another-state")
                .unwrap(),
        );

        assert!(matches!(action, CallbackAction::Ignore));
        assert!(manager.inner.lock().unwrap().pending.is_some());
    }

    #[test]
    fn consumes_a_matching_callback_once() {
        let manager = AccountManager::default();
        manager.inner.lock().unwrap().pending = Some(pending());

        let action = manager.claim_callback(
            &Url::parse("terminalx://auth/callback?code=one-time-code&state=state-value").unwrap(),
        );

        assert!(matches!(
            action,
            CallbackAction::Exchange { code, .. } if code == "one-time-code"
        ));
        assert!(manager.inner.lock().unwrap().pending.is_none());
    }

    #[test]
    fn normalizes_the_desktop_session_identity() {
        let session: DesktopSession = serde_json::from_value(json!({
            "accessToken": " access ",
            "refreshToken": " refresh ",
            "expiresAt": 1_800_000_000_000_i64,
            "cloud": {
                "cloudProfileId": " profile ",
                "userId": " user ",
                "email": " owner@example.com ",
                "displayName": " Owner ",
                "activeOrgId": " org ",
                "activeOrgName": " TerminalX ",
                "linkedAt": 1_700_000_000_000_i64
            },
            "organizations": [{ "orgId": " org ", "name": " TerminalX ", "role": "owner" }],
            "capabilities": { "flags": { "relay.use": true }, "refreshedAt": 1_700_000_000_000_i64 },
            "ignoredServerExtension": true
        }))
        .unwrap();

        let session = normalize_session(session).unwrap();
        assert_eq!(session.access_token, "access");
        assert_eq!(session.cloud.display_name.as_deref(), Some("Owner"));
        assert_eq!(session.cloud.active_org_name.as_deref(), Some("TerminalX"));
    }

    #[test]
    fn carries_per_organization_cloud_capabilities_to_the_webview() {
        let session: DesktopSession = serde_json::from_value(json!({
            "accessToken": "access",
            "refreshToken": "refresh",
            "expiresAt": 1_800_000_000_000_i64,
            "cloud": { "cloudProfileId": "profile", "userId": "user", "email": "a@example.com", "activeOrgId": "org-a", "activeOrgName": "Acme", "linkedAt": 1 },
            "organizations": [
                { "orgId": "org-a", "name": "Acme", "role": "admin", "isPersonal": false, "cloud": { "enabled": true, "flags": { "cloud.session-runtimes.v1": true } } },
                { "orgId": "org-me", "name": "Me", "role": "owner", "isPersonal": true, "cloud": { "enabled": false, "flags": {} } },
                { "orgId": "org-old", "name": "Old", "role": "member" }
            ],
            "capabilities": { "flags": {}, "refreshedAt": 1 }
        }))
        .unwrap();
        let inner = Inner { loaded: true, session: Some(normalize_session(session).unwrap()), generation: 3, ..Default::default() };
        let status = serde_json::to_value(snapshot(&inner)).unwrap();
        assert_eq!(status["identity"]["organizationId"], "org-a");
        let orgs = status["organizations"].as_array().unwrap();
        assert_eq!(orgs[0]["isPersonal"], false);
        assert_eq!(orgs[0]["cloud"]["enabled"], true);
        assert_eq!(orgs[0]["cloud"]["flags"]["cloud.session-runtimes.v1"], true);
        assert_eq!(orgs[1]["isPersonal"], true);
        assert_eq!(orgs[1]["cloud"]["enabled"], false);
        // An older server's organization says nothing about the cloud.
        assert_eq!(orgs[2]["isPersonal"], false);
        assert!(orgs[2].get("cloud").is_none());
    }

    #[test]
    fn a_silent_refresh_that_brings_organization_capabilities_is_announced() {
        let manager = AccountManager::default();
        manager.set_context_for_test(Some(AccountContext {
            access_token: "old-access".into(),
            user_id: "user".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            profile_id: "profile".into(),
            organization_id: "org-a".into(),
            relay_entitled: false,
            generation: 4,
        }));
        let stored = manager.inner.lock().unwrap().session.clone().unwrap();
        assert!(snapshot(&manager.inner.lock().unwrap()).organizations.is_empty());
        let refreshed: DesktopSession = serde_json::from_value(json!({
            "accessToken": "new-access",
            "refreshToken": "new-refresh",
            "expiresAt": 4_000_000_000_000_i64,
            "cloud": { "cloudProfileId": "profile", "userId": "user", "email": "a@example.com", "displayName": "A", "activeOrgId": "org-a", "activeOrgName": "Test Organization", "linkedAt": 1 },
            "organizations": [{ "orgId": "org-a", "name": "Acme", "role": "owner", "isPersonal": false, "cloud": { "enabled": true, "flags": {} } }],
            "capabilities": { "flags": {}, "refreshedAt": 1 }
        }))
        .unwrap();
        assert!(manager.apply_refresh(4, &stored, Ok(refreshed.clone())));
        let status = serde_json::to_value(snapshot(&manager.inner.lock().unwrap())).unwrap();
        assert_eq!(status["organizations"][0]["cloud"]["enabled"], true);
        // The same answer again changes nothing the webview sees, so nothing is announced.
        assert!(!manager.apply_refresh(4, &refreshed, Ok(refreshed.clone())));
        // A refresh for an older generation is dropped.
        assert!(!manager.apply_refresh(3, &refreshed, Ok(stored)));
    }

    #[test]
    fn the_webviews_default_organization_is_the_one_api_calls_use_even_after_a_silent_refresh() {
        let manager = AccountManager::default();
        manager.set_context_for_test(Some(AccountContext {
            access_token: "a".into(),
            user_id: "user".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            profile_id: "profile".into(),
            organization_id: "org-demo".into(),
            relay_entitled: false,
            generation: 2,
        }));
        let stored = manager.inner.lock().unwrap().session.clone().unwrap();
        let mut refreshed = stored.clone();
        refreshed.refresh_token = "rotated".into();
        // The server moved the active organization (another client switched it).
        refreshed.cloud.active_org_id = Some("org-e2e-box".into());
        refreshed.cloud.active_org_name = Some("E2E Box".into());
        assert!(manager.apply_refresh(2, &stored, Ok(refreshed)));
        let status = serde_json::to_value(snapshot(&manager.inner.lock().unwrap())).unwrap();
        let context = manager.inner.lock().unwrap().session.as_ref().unwrap().cloud.active_org_id.clone();
        assert_eq!(status["identity"]["organizationId"], "org-e2e-box");
        assert_eq!(context.as_deref(), Some("org-e2e-box"));
    }

    fn signed_in(active: &str) -> AccountManager {
        let manager = AccountManager::default();
        manager.set_context_for_test(Some(AccountContext {
            access_token: "a".into(),
            user_id: "user".into(),
            email: "a@example.com".into(),
            display_name: "A".into(),
            profile_id: "profile".into(),
            organization_id: active.into(),
            relay_entitled: false,
            generation: 7,
        }));
        manager
    }

    #[test]
    fn without_the_capability_only_the_active_organization_is_reachable_and_kept() {
        let manager = signed_in("org-a");
        manager.set_memberships_for_test(&["org-a", "org-b"], false);
        let scope = manager.current_scope().unwrap();
        assert!(scope.allows("org-a") && !scope.allows("org-b"));
        // Reachable is the active organization only; kept is every member one.
        assert_eq!(scope.kept_orgs(), BTreeSet::from(["org-a".to_string(), "org-b".to_string()]));
        assert_eq!(manager.context_in("org-b").err(), Some("cloud_organization_unavailable"));
        let (context, access) = manager.context_in("org-a").unwrap();
        assert_eq!(access, OrgAccess::Active);
        // As before: a switch of the active organization fences the call.
        manager.set_active_org_for_test("org-b");
        assert!(!manager.is_current_in(&context, access));
        // Switching the active organization drops no member organization's data.
        assert_eq!(manager.current_scope().unwrap().kept_orgs(), scope.kept_orgs());
        assert_eq!(serde_json::to_value(manager.snapshot()).unwrap()["multiOrg"], false);
    }

    #[test]
    fn with_the_capability_every_member_organization_is_reachable_and_a_default_change_keeps_them() {
        let manager = signed_in("org-a");
        manager.set_memberships_for_test(&["org-a", "org-b"], true);
        let before = manager.current_scope().unwrap();
        assert!(before.allows("org-a") && before.allows("org-b") && !before.allows("org-c"));
        assert_eq!(manager.context_in("org-c").err(), Some("cloud_organization_unavailable"));
        let (context, access) = manager.context_in("org-b").unwrap();
        assert_eq!((context.organization_id.as_str(), access), ("org-b", OrgAccess::Member));
        let status = serde_json::to_value(manager.snapshot()).unwrap();
        assert_eq!(status["multiOrg"], true);
        let account = status["context"]["account"].clone();

        // Changing the default organization: the same identity, the same kept
        // organizations, and calls in either stay current.
        manager.set_active_org_for_test("org-b");
        let after = manager.current_scope().unwrap();
        assert_eq!(before.kept_orgs(), after.kept_orgs());
        assert!(manager.is_current_in(&context, access));
        assert_eq!(serde_json::to_value(manager.snapshot()).unwrap()["context"]["account"], account);

        // Leaving an organization: only it stops being reachable and kept.
        let (in_a, access_a) = manager.context_in("org-a").unwrap();
        manager.set_memberships_for_test(&["org-b"], true);
        assert!(!manager.is_current_in(&in_a, access_a));
        assert!(manager.is_current_in(&context, access));
        assert!(manager.context_in("org-a").is_err());
        assert_eq!(manager.current_scope().unwrap().kept_orgs(), BTreeSet::from(["org-b".to_string()]));
    }

    #[test]
    fn a_capability_flap_keeps_every_member_organizations_data() {
        let manager = signed_in("org-a");
        manager.set_memberships_for_test(&["org-a", "org-b"], true);
        let with = manager.current_scope().unwrap().kept_orgs();
        manager.set_memberships_for_test(&["org-a", "org-b"], false);
        let scope = manager.current_scope().unwrap();
        assert_eq!(scope.kept_orgs(), with, "nothing of a still-member organization is purged");
        assert!(!scope.allows("org-b"), "but it is inactive: nothing reaches it");
    }

    fn body(role: &str) -> SessionBody {
        test_session_body(role)
    }

    fn role_of(manager: &AccountManager) -> Option<String> {
        snapshot(&manager.inner.lock().unwrap()).organizations.first().map(|org| org.role.clone())
    }

    #[test]
    fn a_demoted_admins_role_is_read_again_without_rotating_the_token() {
        let manager = signed_in("org-a");
        let start = Instant::now();
        assert!(manager.refresh_roles_with(true, start, |session| {
            assert_eq!(session.access_token, "a", "asked with the access token");
            Ok(body("admin"))
        }));
        assert_eq!(role_of(&manager).as_deref(), Some("admin"));

        // The owner demotes this admin: the next forced read says so, and the
        // tokens and their expiry are the ones already held.
        let before = manager.inner.lock().unwrap().session.clone().unwrap();
        assert!(manager.refresh_roles_with(true, start + ROLES_REFRESH_FLOOR, |_| Ok(body("member"))));
        assert_eq!(role_of(&manager).as_deref(), Some("member"));
        let after = manager.inner.lock().unwrap().session.clone().unwrap();
        assert_eq!((after.access_token, after.refresh_token, after.expires_at), (before.access_token, before.refresh_token, before.expires_at));
        assert_eq!(serde_json::to_value(manager.snapshot()).unwrap()["multiOrg"], true);
        // The generation is the same account's: nothing built on it is torn down.
        assert_eq!(manager.inner.lock().unwrap().generation, 7);
    }

    #[test]
    fn a_role_refresh_is_announced_only_when_what_the_webview_sees_changed() {
        let manager = signed_in("org-a");
        let session = manager.inner.lock().unwrap().session.clone().unwrap();
        assert_eq!(manager.apply_session_body(7, &session, body("admin")), (true, true));
        assert_eq!(manager.apply_session_body(7, &session, body("admin")), (true, false));
        assert_eq!(manager.apply_session_body(7, &session, body("member")), (true, true));
    }

    #[test]
    fn a_role_refresh_for_another_account_or_an_older_session_is_dropped() {
        let manager = signed_in("org-a");
        let session = manager.inner.lock().unwrap().session.clone().unwrap();
        // Signed out and in again while the request ran.
        assert_eq!(manager.apply_session_body(6, &session, body("member")), (false, false));
        // The token rotated while the request ran: the rotation's body is newer.
        let mut older = session.clone();
        older.access_token = "previous".into();
        assert_eq!(manager.apply_session_body(7, &older, body("member")), (false, false));
        // A body for someone else.
        let mut other = body("member");
        other.cloud.user_id = "someone-else".into();
        assert_eq!(manager.apply_session_body(7, &session, other), (false, false));
        // A body that is not a valid session.
        let mut invalid = body("member");
        invalid.capabilities.refreshed_at = 0;
        assert_eq!(manager.apply_session_body(7, &session, invalid), (false, false));
        assert_eq!(role_of(&manager), None, "nothing was taken");
        // Signed out: nothing to refresh, and nothing is asked.
        manager.set_context_for_test(None);
        assert!(!manager.refresh_roles_with(true, Instant::now(), |_| panic!("signed out")));
    }

    #[test]
    fn a_routine_role_refresh_is_throttled_and_a_forced_one_is_not() {
        let start = Instant::now();
        assert!(roles_refresh_due(None, start, false), "the first read (launch) always asks");
        assert!(!roles_refresh_due(Some(start), start + Duration::from_secs(59), false));
        assert!(roles_refresh_due(Some(start), start + Duration::from_secs(60), false));
        assert!(roles_refresh_due(Some(start), start + Duration::from_secs(2), true));
        assert!(!roles_refresh_due(Some(start), start + Duration::from_secs(1), true), "a burst of refusals is one question");

        let manager = signed_in("org-a");
        assert!(manager.refresh_roles_with(false, start, |_| Ok(body("admin"))));
        assert!(!manager.refresh_roles_with(false, start + Duration::from_secs(30), |_| panic!("throttled")));
        assert!(manager.refresh_roles_with(true, start + Duration::from_secs(30), |_| Ok(body("member"))));
        assert_eq!(role_of(&manager).as_deref(), Some("member"));
    }

    #[test]
    fn a_failed_role_refresh_keeps_the_session_and_is_asked_again() {
        let manager = signed_in("org-a");
        let start = Instant::now();
        assert!(manager.refresh_roles_with(true, start, |_| Ok(body("admin"))));
        // Unreachable, or even refused: not a sign-out and not an error to show.
        assert!(!manager.refresh_roles_with(true, start + Duration::from_secs(5), |_| Err(CloudError::Http(401))));
        assert!(!manager.refresh_roles_with(true, start + Duration::from_secs(6), |_| Err(CloudError::Transport)));
        let status = serde_json::to_value(manager.snapshot()).unwrap();
        assert_eq!((status["state"].as_str(), status["lastError"].as_str()), (Some("signed-in"), None));
        assert_eq!(role_of(&manager).as_deref(), Some("admin"));
        // A failure does not count as an answer: the next routine read asks.
        assert!(manager.refresh_roles_with(false, start + Duration::from_secs(61), |_| Ok(body("member"))));
    }

    // ---- a slow or blocked Keychain (the freeze after a stop and wake) ----

    use crate::keychain::testing::{Call, MemorySecrets};
    use std::sync::mpsc;

    /// Signed in as "user" in "org-a" (generation 7), with the session kept in a store the test controls.
    fn signed_in_with_store() -> (Arc<AccountManager>, MemorySecrets) {
        let store = MemorySecrets::default();
        let manager = Arc::new(signed_in("org-a"));
        manager.use_secrets_for_test(Arc::new(store.clone()));
        (manager, store)
    }

    /// What `work` returns, or a failure when it does not return at once: a
    /// read that waits for the Keychain is the bug.
    fn promptly<T: Send + 'static>(what: &str, work: impl FnOnce() -> T + Send + 'static) -> T {
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(work());
        });
        result.recv_timeout(Duration::from_secs(5)).unwrap_or_else(|_| panic!("{what} waited for the Keychain"))
    }

    fn eventually(what: &str, check: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !check() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn stored_session(store: &MemorySecrets) -> Option<DesktopSession> {
        store.stored(TEST_SERVICE, KEYCHAIN_ACCOUNT).map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    fn stored_role(store: &MemorySecrets) -> Option<String> {
        stored_session(store).and_then(|session| session.organizations.first().map(|org| org.role.clone()))
    }

    fn rotated(from: &DesktopSession, role: &str) -> DesktopSession {
        let mut session = from.clone();
        session.access_token = "rotated-access".into();
        session.refresh_token = "rotated-refresh".into();
        session.organizations = vec![Organization { org_id: "org-a".into(), name: "Acme".into(), role: role.into(), is_personal: false, cloud: None }];
        session
    }

    #[test]
    fn reading_the_account_never_waits_for_a_role_refresh_that_is_stuck_saving() {
        let (manager, store) = signed_in_with_store();
        store.block_writes();
        let refreshing = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.refresh_roles_with(true, Instant::now(), |_| Ok(body("member"))))
        };
        // The role refresh is now inside the Keychain write and stays there.
        store.wait_for_blocked(1);

        // Everything the main thread, a cloud send or a poll reads returns at
        // once, and already with what the server answered.
        let scope = {
            let manager = manager.clone();
            promptly("current_scope", move || manager.current_scope())
        };
        assert!(scope.is_some_and(|scope| scope.user_id == "user" && scope.allows("org-a")));
        let context = {
            let manager = manager.clone();
            promptly("context", move || manager.context())
        }
        .expect("signed in");
        let reads = manager.clone();
        assert!(promptly("is_current, is_current_in, current_revision", move || {
            reads.is_current(&context) && reads.is_current_in(&context, OrgAccess::Member) && reads.current_revision().is_some()
        }));
        let status = manager.clone();
        assert_eq!(promptly("the status", move || role_of(&status)).as_deref(), Some("member"));
        // A second refresh (the window was focused again) does not queue up
        // behind the stuck one's throttle lock either: it is throttled.
        let again = manager.clone();
        assert!(!promptly("a second role refresh", move || again.refresh_roles_with(true, Instant::now(), |_| panic!("asked twice"))));
        assert_eq!(stored_role(&store), None, "still being written");

        store.release();
        assert!(refreshing.join().unwrap());
        assert_eq!(stored_role(&store).as_deref(), Some("member"));
    }

    #[test]
    fn a_sign_out_during_a_slow_save_is_not_undone_by_it() {
        let (manager, store) = signed_in_with_store();
        store.block_writes();
        let start = Instant::now();
        let stuck = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.refresh_roles_with(true, start, |_| Ok(body("admin"))))
        };
        store.wait_for_blocked(1);
        // A second refresh has its answer in memory and waits to write it.
        let waiting = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.refresh_roles_with(true, start + ROLES_REFRESH_FLOOR, |_| Ok(body("member"))))
        };
        eventually("the second answer is taken in memory", || role_of(&manager).as_deref() == Some("member"));

        // Sign out while both are outstanding: at once in memory...
        let signing_out = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.end_session())
        };
        eventually("signed out in memory without waiting for the Keychain", || manager.current_scope().is_none());
        assert!(manager.settled_scope().is_none(), "but not confirmed: nothing of the account is dropped yet");
        assert_eq!(manager.inner.lock().unwrap().generation, 8, "and everything made for the account is fenced");

        // ...and in the Keychain once it answers, whichever write goes last.
        store.release();
        assert!(stuck.join().unwrap());
        assert!(waiting.join().unwrap());
        assert!(signing_out.join().unwrap().is_some(), "the ended session is returned for the server to be told");
        assert_eq!(manager.settled_scope(), Some(None), "confirmed");
        assert_eq!(stored_session(&store).map(|session| session.access_token), None, "the saved session is gone, not put back by a late write");
        let calls = store.calls();
        assert_eq!(calls.last(), Some(&Call::Delete));
        assert_eq!(calls.iter().filter(|call| matches!(call, Call::Set(_))).count(), 1, "the waiting write did not save its older session");
        assert!(manager.current_scope().is_none());
    }

    #[test]
    fn an_answer_that_arrives_after_a_sign_out_is_dropped() {
        let (manager, store) = signed_in_with_store();
        let (asked, was_asked) = mpsc::channel();
        let (answer, answered) = mpsc::channel::<()>();
        let refreshing = {
            let manager = manager.clone();
            std::thread::spawn(move || {
                manager.refresh_roles_with(true, Instant::now(), |_| {
                    asked.send(()).unwrap();
                    answered.recv().unwrap();
                    Ok(body("member"))
                })
            })
        };
        was_asked.recv_timeout(Duration::from_secs(10)).unwrap();
        // The request is out; reads do not wait for it, and neither does a sign-out.
        let reads = manager.clone();
        assert!(promptly("current_scope", move || reads.current_scope()).is_some());
        let signing_out = manager.clone();
        assert!(promptly("the sign-out", move || signing_out.end_session()).is_some());
        answer.send(()).unwrap();
        assert!(!refreshing.join().unwrap(), "the answer was for a session that ended");
        assert!(manager.current_scope().is_none());
        assert_eq!(stored_session(&store).map(|session| session.access_token), None);
        assert!(!store.calls().iter().any(|call| matches!(call, Call::Set(_))), "nothing of the ended session was saved");
    }

    #[test]
    fn a_slow_save_of_an_older_session_does_not_replace_a_newer_one() {
        let (manager, store) = signed_in_with_store();
        let before = manager.inner.lock().unwrap().session.clone().unwrap();
        store.block_writes();
        let stuck = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.refresh_roles_with(true, Instant::now(), |_| Ok(body("admin"))))
        };
        store.wait_for_blocked(1);
        let asked_with = manager.inner.lock().unwrap().session.clone().unwrap();

        // The tokens rotate meanwhile (a status read): a newer session, in
        // memory at once, whose write waits behind the stuck one.
        let newer = rotated(&asked_with, "owner");
        assert!(manager.apply_refresh(7, &asked_with, Ok(newer)));
        let saving = {
            let manager = manager.clone();
            std::thread::spawn(move || manager.settle(7, true, Some(REFRESH_NOT_SAVED)))
        };
        let reads = manager.clone();
        assert_eq!(promptly("context", move || reads.context()).unwrap().access_token, "rotated-access");
        // A role answer asked with the tokens from before the rotation is dropped.
        assert_eq!(manager.apply_session_body(7, &before, body("member")), (false, false));

        store.release();
        assert!(stuck.join().unwrap());
        saving.join().unwrap();
        let stored = stored_session(&store).unwrap();
        assert_eq!((stored.access_token.as_str(), stored.refresh_token.as_str()), ("rotated-access", "rotated-refresh"));
        assert_eq!(stored_role(&store).as_deref(), Some("owner"));
        assert_eq!(manager.snapshot().last_error, None);
        // Nothing left to write: the Keychain has the session in memory.
        let writes = store.calls().len();
        manager.settle(7, false, None);
        assert_eq!(store.calls().len(), writes);
    }

    #[test]
    fn no_keychain_call_is_made_while_the_account_is_locked() {
        let store = MemorySecrets::default();
        let manager = Arc::new(AccountManager::default());
        manager.use_secrets_for_test(Arc::new(store.clone()));
        let watched = Arc::downgrade(&manager);
        store.on_call(move || {
            let manager = watched.upgrade().expect("the account outlives its store");
            assert!(manager.inner.try_lock().is_ok(), "a Keychain call was made with the account locked");
        });

        // Launch: the saved session is read.
        let saved = signed_in("org-a").inner.lock().unwrap().session.clone().unwrap();
        store.set(TEST_SERVICE, KEYCHAIN_ACCOUNT, &serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(manager.current_scope().is_none(), "not loaded yet, and not waited for");
        manager.ensure_loaded();
        assert!(manager.current_scope().is_some());
        // A role refresh, a token rotation, a rotation refused as expired, a
        // new sign-in, and a sign-out: each one writes.
        assert!(manager.refresh_roles_with(true, Instant::now(), |_| Ok(body("admin"))));
        let generation = manager.inner.lock().unwrap().generation;
        let current = manager.inner.lock().unwrap().session.clone().unwrap();
        let newer = rotated(&current, "member");
        assert!(manager.apply_refresh(generation, &current, Ok(newer.clone())));
        manager.settle(generation, true, Some(REFRESH_NOT_SAVED));
        assert_eq!(stored_role(&store).as_deref(), Some("member"));
        assert!(manager.apply_refresh(generation, &newer, Err(CloudError::Http(401))));
        manager.settle(generation, true, Some(REFRESH_NOT_SAVED));
        assert_eq!(stored_session(&store).map(|session| session.access_token), None, "an expired session is removed");
        manager.inner.lock().unwrap().signing_in = true;
        assert!(manager.apply_exchange(generation, Ok(saved)));
        assert!(!manager.persist(generation, Some("not saved")));
        assert!(stored_session(&store).is_some());
        assert!(manager.end_session().is_some());
        assert_eq!(stored_session(&store).map(|session| session.access_token), None);
        let calls = store.calls();
        assert_eq!(calls.iter().filter(|call| matches!(call, Call::Set(_))).count(), 4, "the seeded session, the roles, the rotation and the sign-in");
        assert_eq!(calls.iter().filter(|call| **call == Call::Delete).count(), 2, "the expiry and the sign-out");
        assert_eq!(calls.iter().filter(|call| **call == Call::Get).count(), 1, "the session is read once");
    }

    #[test]
    fn a_keychain_that_refuses_is_reported_and_never_signs_out_by_itself() {
        let (manager, store) = signed_in_with_store();
        store.fail_writes(true);
        // A role refresh that cannot be saved is still taken, and is not an error to show.
        assert!(manager.refresh_roles_with(true, Instant::now(), |_| Ok(body("admin"))));
        assert_eq!((role_of(&manager).as_deref(), manager.snapshot().last_error), (Some("admin"), None));
        // A token rotation that cannot be saved says so.
        let current = manager.inner.lock().unwrap().session.clone().unwrap();
        assert!(manager.apply_refresh(7, &current, Ok(rotated(&current, "admin"))));
        manager.settle(7, true, Some(REFRESH_NOT_SAVED));
        assert_eq!(manager.snapshot().last_error.as_deref(), Some(REFRESH_NOT_SAVED));
        // A sign-out that cannot remove the saved session stays signed in, as
        // the next launch would be.
        assert!(manager.end_session().is_none());
        assert!(manager.settled_scope().is_some_and(|scope| scope.is_some()), "settled, and signed in");
        let status = serde_json::to_value(manager.snapshot()).unwrap();
        assert_eq!(status["state"], "signed-in");
        assert_eq!(status["lastError"], "Sign-out could not remove the account session from macOS Keychain.");
        assert_eq!(manager.context().unwrap().access_token, "rotated-access");
        // Once the Keychain answers again the sign-out goes through.
        store.fail_writes(false);
        assert!(manager.end_session().is_some());
        assert!(manager.current_scope().is_none());
        assert_eq!(stored_session(&store).map(|session| session.access_token), None);
    }

    #[test]
    fn refreshes_before_expiry() {
        assert!(!should_refresh(1_000_061_000, 1_000_000_000));
        assert!(should_refresh(1_000_060_000, 1_000_000_000));
        assert!(should_refresh(999_999_999, 1_000_000_000));
    }

    #[test]
    fn rejects_service_completion_after_account_or_organization_changes() {
        let session = || {
            serde_json::from_value::<DesktopSession>(json!({
                "accessToken": "access-one",
                "refreshToken": "refresh-one",
                "expiresAt": 1_900_000_000_000_i64,
                "cloud": {
                    "cloudProfileId": "profile-one",
                    "userId": "user-one",
                    "email": "owner@example.com",
                    "activeOrgId": "org-one",
                    "linkedAt": 1_700_000_000_000_i64
                },
                "organizations": [{ "orgId": "org-one", "name": "One", "role": "owner" }],
                "capabilities": { "flags": {}, "refreshedAt": 1_700_000_000_000_i64 }
            }))
            .unwrap()
        };
        let manager = AccountManager::default();
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.loaded = true;
            inner.generation = 9;
            inner.session = Some(session());
        }
        let request_context = manager.context().unwrap();
        assert!(manager.is_current(&request_context));

        manager.inner.lock().unwrap().generation = 10;
        assert!(!manager.is_current(&request_context));

        {
            let mut inner = manager.inner.lock().unwrap();
            inner.generation = request_context.generation;
            inner.session = Some(session());
            inner.session.as_mut().unwrap().cloud.active_org_id = Some("org-two".into());
        }
        assert!(!manager.is_current(&request_context));

        {
            let mut inner = manager.inner.lock().unwrap();
            inner.session = Some(session());
            inner.session.as_mut().unwrap().access_token = "refreshed-access".into();
        }
        assert!(manager.is_current(&request_context));

        manager
            .inner
            .lock()
            .unwrap()
            .session
            .as_mut()
            .unwrap()
            .cloud
            .cloud_profile_id = "profile-two".into();
        assert!(!manager.is_current(&request_context));
    }

    #[test]
    fn rejects_authoritative_selection_for_a_different_organization() {
        assert!(selection_matches("org-one", Some("org-one")));
        assert!(!selection_matches("org-one", Some("org-two")));
        assert!(!selection_matches("org-one", None));
    }

    #[test]
    fn default_keychain_service_is_application_scoped() {
        assert_eq!(keychain_service_name("com.example.test"), "com.example.test.account");
    }

    #[test]
    fn dev_keychain_service_is_debug_only_and_namespaced() {
        assert_eq!(dev_keychain_service_from(true, Some("dev.terminalx.alice")).as_deref(), Some("dev.terminalx.alice"));
        assert_eq!(dev_keychain_service_from(true, Some("  dev.terminalx.bob \n")).as_deref(), Some("dev.terminalx.bob"));
        assert_eq!(dev_keychain_service_from(false, Some("dev.terminalx.alice")), None, "release builds ignore it");
        assert_eq!(dev_keychain_service_from(true, Some("com.terminalx.next")), None, "only a dev.terminalx.* service");
        assert_eq!(dev_keychain_service_from(true, Some(&format!("dev.terminalx.{}", "x".repeat(120)))), None);
        assert_eq!(dev_keychain_service_from(true, None), None);
    }

    #[test]
    fn dev_api_base_url_is_debug_only_and_origin_only() {
        assert_eq!(dev_api_base_url(true, Some("http://127.0.0.1:42220")).as_deref(), Some("http://127.0.0.1:42220"));
        assert_eq!(dev_api_base_url(true, Some("https://staging.example/")).as_deref(), Some("https://staging.example"));
        assert_eq!(dev_api_base_url(false, Some("http://127.0.0.1:42220")), None, "release builds ignore it");
        assert_eq!(dev_api_base_url(true, Some("http://api.example")), None, "plain HTTP only on loopback");
        assert_eq!(dev_api_base_url(true, Some("https://api.example/v1")), None);
        assert_eq!(dev_api_base_url(true, None), None);
    }
}
