use super::*;

use std::io::Read;

const PROFILE_PATH: &str = "/v1/desktop/auth/display-name";
const MAX_NAME_LENGTH: usize = 100;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatedProfile {
    display_name: String,
}

#[derive(Deserialize)]
struct ProfileError {
    error: String,
}

fn profile_error(status: u16, code: Option<&str>) -> &'static str {
    match (status, code) {
        (401 | 403, _) => "The account service did not authorize this desktop session. Sign in and try again.",
        (400, Some("display_name_required")) => "Enter a display name.",
        (400, Some("display_name_too_long")) => "Display names must be 100 characters or fewer.",
        (400, Some("invalid_request")) => "The account service could not read the display name.",
        (404, Some("user_not_found")) => "Your account could not be found.",
        (404, _) => "This account service does not support editing display names from the desktop.",
        (413, _) => "The display name request is too large.",
        _ => "Couldn’t save your display name. Try again.",
    }
}

fn validated_name(name: &str) -> Result<&str, &'static str> {
    // Match String.trim() and String.length on the account service.
    let name = name.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    if name.is_empty() {
        return Err("Enter a display name.");
    }
    if name.encode_utf16().count() > MAX_NAME_LENGTH {
        return Err("Display names must be 100 characters or fewer.");
    }
    Ok(name)
}

fn put_profile(url: &str, access_token: &str, name: &str) -> Result<UpdatedProfile, &'static str> {
    let response = match cloud_agent()
        .put(url)
        .set("content-type", "application/json")
        .set("authorization", &format!("Bearer {access_token}"))
        .send_json(json!({ "displayName": name }))
    {
        Ok(response) if response.status() == 200 => response,
        Ok(response) | Err(ureq::Error::Status(_, response)) => {
            let status = response.status();
            let body = serde_json::from_reader::<_, ProfileError>(response.into_reader().take(4096)).ok();
            return Err(profile_error(status, body.as_ref().map(|body| body.error.as_str())));
        }
        Err(ureq::Error::Transport(_)) => return Err(profile_error(0, None)),
    };
    serde_json::from_reader(response.into_reader().take(4096))
        .map_err(|_| "The account service returned an invalid display name.")
}

impl AccountManager {
    pub(crate) fn update_display_name(
        &self,
        app: &AppHandle,
        enabled: bool,
        name: &str,
        revision: &str,
    ) -> Result<AccountStatus, &'static str> {
        self.attach_app(app);
        self.update_display_name_with(
            enabled,
            name,
            revision,
            || self.context(),
            |token, name| put_profile(&endpoint(PROFILE_PATH), token, name),
        )
    }

    fn update_display_name_with(
        &self,
        enabled: bool,
        name: &str,
        revision: &str,
        prepare: impl FnOnce() -> Option<AccountContext>,
        send: impl FnOnce(&str, &str) -> Result<UpdatedProfile, &'static str>,
    ) -> Result<AccountStatus, &'static str> {
        if !enabled {
            return Err("Editing your display name is unavailable.");
        }
        crate::data_privacy::require_network()
            .map_err(|_| "Turn off data privacy mode to edit your display name.")?;
        let name = validated_name(name)?;
        let _save = self.display_name_gate.lock().unwrap();
        let context = prepare().ok_or("Sign in to edit your display name.")?;
        let changed_account = "Your account changed while saving. Open the editor and try again.";
        if Self::context_revision(&context) != revision {
            return Err(changed_account);
        }

        let current = |inner: &Inner| {
            inner.generation == context.generation
                && inner.session.as_ref().is_some_and(|session| {
                    session.cloud.user_id == context.user_id
                        && session.cloud.cloud_profile_id == context.profile_id
                })
        };
        let access_token = {
            let _gate = self.refresh_gate.lock().unwrap();
            let inner = self.inner.lock().unwrap();
            if !current(&inner) {
                return Err(changed_account);
            }
            inner
                .session
                .as_ref()
                .ok_or(changed_account)?
                .access_token
                .clone()
        };
        let updated = send(&access_token, name)?;
        if validated_name(&updated.display_name) != Ok(updated.display_name.as_str()) {
            return Err("The account service returned an invalid display name.");
        }
        let changed = {
            let _gate = self.refresh_gate.lock().unwrap();
            let mut inner = self.inner.lock().unwrap();
            if !current(&inner) {
                return Err(changed_account);
            }
            let mut session = inner.session.clone().ok_or(changed_account)?;
            let changed = session.cloud.display_name.as_deref() != Some(updated.display_name.as_str());
            if changed {
                session.cloud.display_name = Some(updated.display_name);
                inner.set_session(Some(session));
            }
            changed
        };
        self.settle(context.generation, changed, None);
        let inner = self.inner.lock().unwrap();
        if !current(&inner) {
            return Err(changed_account);
        }
        Ok(snapshot(&inner))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::testing::MemorySecrets;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    fn account() -> (AccountManager, MemorySecrets, AccountContext) {
        let account = AccountManager::default();
        let store = MemorySecrets::default();
        account.use_secrets_for_test(Arc::new(store.clone()));
        let context = AccountContext {
            access_token: "opaque-desktop-token".into(),
            user_id: "person".into(),
            profile_id: "profile".into(),
            organization_id: "org".into(),
            email: "person@example.com".into(),
            display_name: "Before".into(),
            relay_entitled: false,
            generation: 7,
        };
        account.set_context_for_test(Some(context.clone()));
        (account, store, context)
    }

    #[test]
    fn puts_the_name_with_desktop_auth_and_persists_the_confirmed_identity() {
        let (account, store, context) = account();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}{PROFILE_PATH}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            stream.read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), "PUT /v1/desktop/auth/display-name HTTP/1.1");
            let mut length = 0;
            let mut authorized = false;
            loop {
                line.clear();
                stream.read_line(&mut line).unwrap();
                let header = line.trim_end().to_ascii_lowercase();
                if header.is_empty() {
                    break;
                }
                if let Some(value) = header.strip_prefix("content-length: ") {
                    length = value.parse().unwrap();
                }
                authorized |= header == "authorization: bearer opaque-desktop-token";
            }
            assert!(authorized);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                json!({"displayName": "New Name"})
            );
            let response = r#"{"displayName":"New Name"}"#;
            write!(stream.get_mut(), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        });

        let revision = AccountManager::context_revision(&context);
        let status = account
            .update_display_name_with(
                true,
                "  New Name  ",
                &revision,
                || Some(context),
                |token, name| {
                    assert!(account.refresh_gate.try_lock().is_ok());
                    put_profile(&url, token, name)
                },
            )
            .unwrap();
        server.join().unwrap();

        assert_eq!(status.identity.unwrap().name.as_deref(), Some("New Name"));
        assert_eq!(status.context.unwrap().revision, revision);
        let saved = store
            .stored(account.service().unwrap(), KEYCHAIN_ACCOUNT)
            .unwrap();
        let session: DesktopSession = serde_json::from_slice(&saved).unwrap();
        assert_eq!(session.cloud.display_name.as_deref(), Some("New Name"));
        assert_eq!(session.cloud.active_org_id.as_deref(), Some("org"));
        assert_eq!(session.access_token, "opaque-desktop-token");
    }

    #[test]
    fn validates_before_sending_and_keeps_the_name_on_failure() {
        let (account, store, context) = account();
        let revision = AccountManager::context_revision(&context);
        for (enabled, name) in [
            (false, "After".into()),
            (true, " \u{feff} ".into()),
            (true, "😀".repeat(51)),
        ] {
            assert!(account
                .update_display_name_with(
                    enabled,
                    &name,
                    &revision,
                    || panic!("opened a session"),
                    |_, _| panic!("sent a PUT")
                )
                .is_err());
        }
        assert_eq!(
            validated_name(&"😀".repeat(50))
                .unwrap()
                .encode_utf16()
                .count(),
            100
        );
        assert_eq!(
            account
                .update_display_name_with(
                    true,
                    "After",
                    &revision,
                    || Some(context.clone()),
                    |_, _| Err("service unavailable")
                )
                .err(),
            Some("service unavailable")
        );
        assert!(account
            .update_display_name_with(
                true,
                "After",
                &revision,
                || Some(context),
                |_, _| {
                    account.set_context_for_test(None);
                    Ok(UpdatedProfile {
                        display_name: "After".into(),
                    })
                }
            )
            .is_err());
        assert!(account.snapshot().identity.is_none());
        assert!(store.calls().is_empty());
    }
}
