//! Owner deletion contract v1: explicit membership target, never select it to delete it.
//! Tokens stay native. Server ownership, resource and personal-org checks are authoritative.
use std::io::Read;
use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteError {
    pub code: String,
    pub blockers: Vec<String>,
}

impl DeleteError {
    pub(crate) fn local(code: &str) -> Self { Self { code: code.into(), blockers: Vec::new() } }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Deleted { organization_id: String, deleted: bool }

fn decode_success(bytes: &[u8], target: &str) -> Result<(), DeleteError> {
    let body: Deleted = serde_json::from_slice(bytes).map_err(|_| DeleteError::local("organization_delete_outcome_unknown"))?;
    if !body.deleted || body.organization_id != target {
        return Err(DeleteError::local("organization_delete_outcome_unknown"));
    }
    Ok(())
}

fn decode_error(bytes: &[u8]) -> DeleteError {
    let body: serde_json::Value = serde_json::from_slice(bytes).unwrap_or_default();
    let code = body.get("error").and_then(|v| v.as_str()).unwrap_or("");
    let known = matches!(code, "invalid_access_token" | "organization_not_found" | "organization_owner_required"
        | "organization_personal_protected" | "organization_confirmation_invalid" | "organization_delete_blocked" | "organization_delete_busy");
    let mut result = DeleteError::local(if known { code } else { "organization_delete_outcome_unknown" });
    if code == "organization_delete_blocked" {
        result.blockers = body.get("blockers").and_then(|v| v.as_array()).into_iter().flatten()
            .filter_map(|v| v.get("code").and_then(|v| v.as_str()))
            .filter(|v| matches!(*v, "cloud_cleanup_required" | "provider_disconnect_required" | "teardown_in_progress" | "github_disconnect_required"))
            .map(str::to_owned).collect();
    }
    result
}

fn read_body(response: ureq::Response) -> Result<Vec<u8>, DeleteError> {
    let mut bytes = Vec::new();
    response.into_reader().take(64 * 1024 + 1).read_to_end(&mut bytes)
        .map_err(|_| DeleteError::local("organization_delete_outcome_unknown"))?;
    if bytes.len() > 64 * 1024 { return Err(DeleteError::local("organization_delete_outcome_unknown")); }
    Ok(bytes)
}

fn delete_url(base: &str, target: &str) -> Result<Url, DeleteError> {
    let mut url = Url::parse(base).map_err(|_| DeleteError::local("organization_delete_unavailable"))?;
    url.path_segments_mut().map_err(|_| DeleteError::local("organization_delete_unavailable"))?
        .extend(["v1", "desktop", "orgs", target, "delete"]);
    Ok(url)
}

fn send(context: &AccountContext, target: &str, name: &str) -> Result<(), DeleteError> {
    let url = delete_url(&api_base_url(), target)?;
    let response = ureq::AgentBuilder::new().timeout(REQUEST_TIMEOUT).redirects(0).build()
        .post(url.as_str()).set("authorization", &format!("Bearer {}", context.access_token))
        .send_json(json!({ "confirmationName": name }));
    match response {
        Ok(response) if response.status() == 200 => decode_success(&read_body(response)?, target),
        Ok(_) => Err(DeleteError::local("organization_delete_outcome_unknown")),
        Err(ureq::Error::Status(_, response)) => Err(decode_error(&read_body(response)?)),
        Err(ureq::Error::Transport(_)) => Err(DeleteError::local("organization_delete_outcome_unknown")),
    }
}

impl AccountManager {
    pub(crate) fn delete_organization(&self, app: &AppHandle, target: &str, revision: &str, name: &str) -> Result<RolesRefresh, DeleteError> {
        self.attach_app(app);
        self.delete_organization_and_refresh(target, revision, name, send, fetch_session_body)
    }

    // Shared by the public command and deterministic tests. Only network I/O is
    // supplied: account/revision checks, locks, removal, persistence and refresh
    // below are the production path, including its post-deletion capability fetch.
    fn delete_organization_and_refresh(&self, target: &str, revision: &str, name: &str,
        request: impl FnOnce(&AccountContext, &str, &str) -> Result<(), DeleteError>,
        fetch: impl FnOnce(&DesktopSession) -> Result<SessionBody, CloudError>) -> Result<RolesRefresh, DeleteError> {
        let context = self.context().ok_or_else(|| DeleteError::local("account_signed_out"))?;
        if Self::context_revision(&context) != revision { return Err(DeleteError::local("account_context_changed")); }
        // Serialize with capability refresh: an older list cannot arrive after the committed removal.
        let mut refresh_guard = self.roles_refreshed.lock().unwrap();
        let token_guard = self.refresh_gate.lock().unwrap();
        self.delete_organization_with(&context, target, name, request)?;
        *refresh_guard = None; // A confirmed mutation must not reuse the recent-role throttle.
        drop(token_guard);
        drop(refresh_guard);
        self.settle(context.generation, true, Some("Organization deleted, but the updated account could not be saved. Refresh the account before restarting."));
        // Refresh membership/capabilities, not selection. If refresh is offline the committed
        // removal is already applied; the backend contract clears deleted selection.
        let fresh = self.refresh_roles_with(true, Instant::now(), fetch);
        Ok(RolesRefresh { status: self.snapshot(), fresh })
    }

    fn delete_organization_with(&self, context: &AccountContext, target: &str, name: &str,
        request: impl FnOnce(&AccountContext, &str, &str) -> Result<(), DeleteError>) -> Result<(), DeleteError> {
        if !self.is_current(context) { return Err(DeleteError::local("account_context_changed")); }
        {
            let inner = self.inner.lock().unwrap();
            let org = inner.session.as_ref().and_then(|s| s.organizations.iter().find(|o| o.org_id == target))
                .ok_or_else(|| DeleteError::local("organization_not_found"))?;
            if org.role != "owner" { return Err(DeleteError::local("organization_owner_required")); }
            if org.is_personal { return Err(DeleteError::local("organization_personal_protected")); }
            if name.is_empty() || org.name != name { return Err(DeleteError::local("organization_confirmation_invalid")); }
        }
        request(context, target, name)?;
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != context.generation || !inner.session.as_ref().is_some_and(|s|
            s.cloud.user_id == context.user_id && s.cloud.cloud_profile_id == context.profile_id) {
            return Err(DeleteError::local("account_context_changed_after_send"));
        }
        let mut session = inner.session.clone().ok_or_else(|| DeleteError::local("account_context_changed_after_send"))?;
        session.organizations.retain(|org| org.org_id != target);
        if session.cloud.active_org_id.as_deref() == Some(target) {
            session.cloud.active_org_id = None;
            session.cloud.active_org_name = None;
        }
        inner.set_session(Some(session));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> AccountManager {
        let manager = AccountManager::default();
        let body = test_session_body("owner");
        let mut organizations = body.organizations;
        let mut other = organizations[0].clone();
        other.org_id = "org-b".into(); other.name = "Test organization".into(); organizations.push(other);
        manager.inner.lock().unwrap().set_session(Some(DesktopSession {
            access_token: "token".into(), refresh_token: "refresh".into(), expires_at: i64::MAX,
            cloud: body.cloud, organizations, capabilities: body.capabilities,
        }));
        manager
    }
    fn context(manager: &AccountManager) -> AccountContext {
        AccountContext { user_id: "user".into(), profile_id: "profile".into(), organization_id: "org-a".into(),
            email: "a@example.com".into(), display_name: "A".into(), relay_entitled: false,
            access_token: "token".into(), generation: manager.inner.lock().unwrap().generation }
    }

    #[test]
    fn target_is_one_encoded_contract_path_segment() {
        let url = delete_url("https://example.invalid", "test/org?query#fragment").unwrap();
        assert_eq!(url.as_str(), "https://example.invalid/v1/desktop/orgs/test%2Forg%3Fquery%23fragment/delete");
        assert!(url.query().is_none()); assert!(url.fragment().is_none());
    }
    #[test]
    fn success_requires_matching_committed_target() {
        assert!(decode_success(br#"{"organizationId":"a","deleted":true}"#, "a").is_ok());
        for body in [br#"{}"#.as_slice(), br#"{"organizationId":"b","deleted":true}"#, br#"{"organizationId":"a","deleted":false}"#] {
            assert_eq!(decode_success(body, "a").unwrap_err().code, "organization_delete_outcome_unknown");
        }
    }
    #[test]
    fn errors_allowlist_blockers_and_ignore_external_cleanup_urls() {
        let error = decode_error(br#"{"error":"organization_delete_blocked","cleanupPath":"https://evil.invalid","blockers":[{"code":"provider_disconnect_required"},{"code":"arbitrary server text"}]}"#);
        assert_eq!(error.code, "organization_delete_blocked");
        assert_eq!(error.blockers, ["provider_disconnect_required"]);
        assert_eq!(decode_error(br#"{"error":"secret server detail"}"#).code, "organization_delete_outcome_unknown");
    }
    #[test]
    fn inactive_target_does_not_select_it_and_active_deletion_clears_without_fallback() {
        let manager = manager(); let context = context(&manager);
        manager.delete_organization_with(&context, "org-b", "Test organization", |ctx, target, name| {
            assert_eq!(ctx.organization_id, "org-a"); assert_eq!(target, "org-b"); assert_eq!(name, "Test organization"); Ok(())
        }).unwrap();
        assert_eq!(manager.inner.lock().unwrap().session.as_ref().unwrap().cloud.active_org_id.as_deref(), Some("org-a"));
        manager.delete_organization_with(&context, "org-a", "Acme", |_, _, _| Ok(())).unwrap();
        let inner = manager.inner.lock().unwrap(); let session = inner.session.as_ref().unwrap();
        assert!(session.cloud.active_org_id.is_none()); assert!(session.organizations.is_empty());
    }
    #[test]
    fn refusal_keeps_membership_and_confirmation_is_not_sent_when_ineligible() {
        let manager = manager(); let context = context(&manager);
        assert_eq!(manager.delete_organization_with(&context, "org-b", "wrong", |_, _, _| panic!("must not send")).unwrap_err().code, "organization_confirmation_invalid");
        assert!(manager.delete_organization_with(&context, "org-b", "Test organization", |_, _, _| Err(DeleteError::local("organization_delete_blocked"))).is_err());
        assert_eq!(manager.inner.lock().unwrap().session.as_ref().unwrap().organizations.len(), 2);
        for (role, personal, expected) in [("admin", false, "organization_owner_required"), ("owner", true, "organization_personal_protected")] {
            { let mut inner = manager.inner.lock().unwrap(); let org = &mut inner.session.as_mut().unwrap().organizations[1]; org.role = role.into(); org.is_personal = personal; }
            assert_eq!(manager.delete_organization_with(&context, "org-b", "Test organization", |_, _, _| panic!("must not send")).unwrap_err().code, expected);
        }
    }
    #[test]
    fn account_replacement_during_request_cannot_remove_new_account_memberships() {
        let manager = manager(); let context = context(&manager);
        assert_eq!(manager.delete_organization_with(&context, "org-b", "Test organization", |_, _, _| {
            manager.inner.lock().unwrap().generation += 1; Ok(())
        }).unwrap_err().code, "account_context_changed_after_send");
        assert_eq!(manager.inner.lock().unwrap().session.as_ref().unwrap().organizations.len(), 2);
    }

    #[test]
    fn stale_context_refuses_before_send_and_active_removal_preserves_remaining_memberships() {
        let manager = manager(); let mut stale = context(&manager);
        stale.generation += 1;
        assert_eq!(manager.delete_organization_with(&stale, "org-a", "Acme", |_, _, _| panic!("must not send")).unwrap_err().code, "account_context_changed");
        manager.delete_organization_with(&context(&manager), "org-a", "Acme", |_, _, _| Ok(())).unwrap();
        let inner = manager.inner.lock().unwrap(); let session = inner.session.as_ref().unwrap();
        assert!(session.cloud.active_org_id.is_none());
        assert_eq!(session.organizations.len(), 1);
        assert_eq!(session.organizations[0].org_id, "org-b");
        assert_eq!(session.access_token, "token", "account and credentials are not deleted");
    }

    // Runs the public deletion command's orchestration, substituting only HTTP
    // responses and the existing in-memory SecretStore. No AppHandle/GUI, real
    // credentials, environment override, network or sleep is needed.
    fn delayed_postdelete_refresh(initial_active: &str) {
        use crate::keychain::testing::MemorySecrets;
        use std::sync::mpsc;

        let manager = Arc::new(manager());
        let store = MemorySecrets::default();
        manager.use_secrets_for_test(Arc::new(store.clone()));
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.loaded = true;
            let session = inner.session.as_mut().unwrap();
            let mut c = session.organizations[1].clone();
            c.org_id = "org-c".into(); c.name = "C".into(); session.organizations.push(c);
            session.cloud.active_org_id = Some(initial_active.into());
            session.cloud.active_org_name = Some(initial_active.into());
        }
        let revision = AccountManager::context_revision(&manager.context().unwrap());
        let (captured_tx, captured_rx) = mpsc::channel();
        let (deliver_tx, deliver_rx) = mpsc::channel();
        let (select_started_tx, select_started_rx) = mpsc::channel();
        let (select_sent_tx, select_sent_rx) = mpsc::channel();
        let deadline = Duration::from_secs(5);

        std::thread::scope(|scope| {
            let deleting = manager.clone();
            let deletion = scope.spawn(move || deleting.delete_organization_and_refresh("org-a", &revision, "Acme",
                |_, target, name| { assert_eq!((target, name), ("org-a", "Acme")); Ok(()) },
                |session| {
                    // Freeze the earlier server reply before B is requested.
                    let body = SessionBody { cloud: session.cloud.clone(), organizations: session.organizations.clone(), capabilities: session.capabilities.clone() };
                    let context = AccountContext {
                        user_id: session.cloud.user_id.clone(), profile_id: session.cloud.cloud_profile_id.clone(),
                        email: session.cloud.email.clone(), display_name: "A".into(), relay_entitled: false,
                        organization_id: session.cloud.active_org_id.clone().unwrap_or_default(),
                        access_token: session.access_token.clone(), generation: deleting.inner.lock().unwrap().generation,
                    };
                    captured_tx.send((context, body.cloud.active_org_id.clone(), body.organizations.iter().map(|org| org.org_id.clone()).collect::<Vec<_>>())).unwrap();
                    deliver_rx.recv_timeout(deadline).expect("deliver held capability response");
                    Ok(body)
                }));
            let (context, old_active, remaining) = captured_rx.recv_timeout(deadline).expect("post-delete refresh reached");
            // Deterministic discriminator: with the old implementation this gate
            // is available while the stale response is pending, regardless of scheduling.
            let refresh_held = matches!(manager.refresh_gate.try_lock(), Err(std::sync::TryLockError::WouldBlock));
            let roles_held = matches!(manager.roles_refreshed.try_lock(), Err(std::sync::TryLockError::WouldBlock));
            let selecting = manager.clone();
            let selection = scope.spawn(move || {
                select_started_tx.send(()).unwrap();
                selecting.select_organization_with("org-b", &context, || {
                    select_sent_tx.send(()).unwrap();
                    let inner = selecting.inner.lock().unwrap();
                    let session = inner.session.as_ref().unwrap();
                    let mut cloud = session.cloud.clone();
                    cloud.active_org_id = Some("org-b".into()); cloud.active_org_name = Some("B".into());
                    Ok(SelectionBody { cloud, organizations: session.organizations.clone() })
                })
            });
            select_started_rx.recv_timeout(deadline).expect("explicit selection queued");
            let selection_not_sent = matches!(select_sent_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
            deliver_tx.send(()).unwrap();
            assert!(deletion.join().unwrap().unwrap().fresh);
            selection.join().unwrap().unwrap();
            assert!(refresh_held && roles_held, "capability fetch/application must hold roles then refresh gates");
            assert!(selection_not_sent, "explicit selection must not send until the earlier response is applied");
            assert_eq!(old_active.as_deref(), (initial_active != "org-a").then_some(initial_active), "deleting selected A must not auto-select a fallback");
            assert_eq!(remaining, ["org-b", "org-c"]);
        });

        let current = manager.inner.lock().unwrap().session.clone().unwrap();
        let saved: DesktopSession = serde_json::from_slice(&store.stored(TEST_SERVICE, KEYCHAIN_ACCOUNT).unwrap()).unwrap();
        for session in [current, saved] {
            assert_eq!(session.cloud.active_org_id.as_deref(), Some("org-b"));
            assert_eq!(session.cloud.active_org_name.as_deref(), Some("B"));
            assert_eq!(session.organizations.iter().map(|org| org.org_id.as_str()).collect::<Vec<_>>(), ["org-b", "org-c"]);
            assert_eq!((session.access_token.as_str(), session.refresh_token.as_str()), ("token", "refresh"));
        }
        assert!(manager.refresh_gate.try_lock().is_ok());
        assert!(manager.roles_refreshed.try_lock().is_ok());
    }

    #[test]
    fn public_delete_refresh_cannot_clear_new_explicit_selection_with_delayed_no_selection_reply() {
        delayed_postdelete_refresh("org-a");
    }

    #[test]
    fn public_delete_refresh_cannot_restore_previous_active_org_over_new_selection() {
        delayed_postdelete_refresh("org-c");
    }

    #[test]
    fn postdelete_refresh_still_fences_replacement_account_and_credentials() {
        use crate::keychain::testing::MemorySecrets;
        for replace_account in [true, false] {
            let manager = manager();
            manager.use_secrets_for_test(Arc::new(MemorySecrets::default()));
            manager.inner.lock().unwrap().loaded = true;
            let revision = AccountManager::context_revision(&manager.context().unwrap());
            let result = manager.delete_organization_and_refresh("org-a", &revision, "Acme", |_, _, _| Ok(()), |session| {
                let body = SessionBody { cloud: session.cloud.clone(), organizations: session.organizations.clone(), capabilities: session.capabilities.clone() };
                let mut inner = manager.inner.lock().unwrap();
                let mut replacement = session.clone();
                replacement.access_token = "new-access".into(); replacement.refresh_token = "new-refresh".into();
                if replace_account {
                    inner.generation += 1;
                    replacement.cloud.user_id = "replacement-user".into();
                    replacement.cloud.cloud_profile_id = "replacement-profile".into();
                }
                replacement.cloud.active_org_id = Some("org-b".into());
                inner.set_session(Some(replacement));
                Ok(body)
            }).unwrap();
            assert!(!result.fresh, "old response must be rejected");
            let inner = manager.inner.lock().unwrap(); let session = inner.session.as_ref().unwrap();
            assert_eq!(session.cloud.active_org_id.as_deref(), Some("org-b"));
            assert_eq!(session.access_token, "new-access"); assert_eq!(session.refresh_token, "new-refresh");
            assert_eq!(session.cloud.user_id, if replace_account { "replacement-user" } else { "user" });
            assert!(!session.organizations.iter().any(|org| org.org_id == "org-a"));
        }
    }
}
