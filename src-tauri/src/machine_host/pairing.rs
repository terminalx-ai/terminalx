//! Pairing a computer by code (PRO-342, docs/MACHINES.md "As built
//! (PRO-342)"): the one live code, the one computer waiting for Allow, and
//! the attempt limit. Nothing here touches a socket or a file: the listener
//! asks ([`Pairing::ask`]) and waits on the answer, the window's commands
//! answer, and [`super::MachineHost`] writes the paired computer.
//!
//! The code's token is kept only as its SHA-256, in memory, so a restarted
//! runtime has no code. Times are milliseconds since the epoch, passed in.

use std::collections::VecDeque;

use subtle::ConstantTimeEq;
use tokio::sync::watch;

use crate::machine_wire::{
    CodeExpiry, PendingComputer, APPROVAL_TTL_MS, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS, CODE_TTL_MS, PAUSE_MS, REFUSED_ANOTHER_COMPUTER,
    REFUSED_CODE_INACTIVE, REFUSED_NOT_APPROVED, REFUSED_PAIRING_PAUSED,
};

/// What a waiting computer is told.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Waiting,
    /// Its record is written; it is admitted as a paired computer.
    Approved,
    /// `pairing_refused` with this reason.
    Refused(&'static str),
}

/// The answer to a token that is not a paired computer's.
pub(crate) enum Decision {
    /// Wait for Allow on this request.
    Wait { request_id: String, outcome: watch::Receiver<Outcome> },
    Refuse(&'static str),
}

/// Who asks, as its `e2ee_auth` and handshake say.
pub(crate) struct Asking<'a> {
    pub token_hash: [u8; 32],
    pub client_key_b64: &'a str,
    pub label: String,
    pub platform: Option<String>,
    /// The pairing fingerprint for this token and the connection's client key.
    pub fingerprint: String,
    pub transport: &'static str,
}

/// What [`Pairing::approving`] hands the host to write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Approving {
    pub request_id: String,
    pub token_hash: [u8; 32],
    pub client_key_b64: String,
    pub label: String,
    pub platform: Option<String>,
    pub fingerprint: String,
    /// The account grant the code answered, if it did.
    pub grant_request_id: Option<String>,
}

struct LiveCode {
    token_hash: [u8; 32],
    expires_at: i64,
    grant_request_id: Option<String>,
}

struct Pending {
    view: PendingComputer,
    token_hash: [u8; 32],
    client_key_b64: String,
    grant_request_id: Option<String>,
    /// Connections waiting on it; the last one closing declines it.
    waiters: usize,
    outcome: watch::Sender<Outcome>,
}

pub(crate) struct Pairing {
    code: Option<LiveCode>,
    pending: Option<Pending>,
    /// When the recent wrong attempts were made.
    wrong: VecDeque<i64>,
    paused_until: Option<i64>,
    approval_ttl_ms: i64,
}

impl Default for Pairing {
    fn default() -> Self {
        Self::with_approval_ttl(APPROVAL_TTL_MS)
    }
}

impl Pairing {
    pub(crate) fn with_approval_ttl(approval_ttl_ms: i64) -> Self {
        Self { code: None, pending: None, wrong: VecDeque::new(), paused_until: None, approval_ttl_ms }
    }

    pub(crate) fn approval_ttl_ms(&self) -> i64 {
        self.approval_ttl_ms
    }

    /// Until when pairing is paused, if it is.
    pub(crate) fn paused_until(&self, now: i64) -> Option<i64> {
        self.paused_until.filter(|until| *until > now)
    }

    /// A wrong or expired attempt (docs/MACHINES.md rules 2 and 4). The fifth
    /// within a minute pauses pairing until a minute after it.
    pub(crate) fn wrong_attempt(&mut self, now: i64) {
        self.wrong.push_back(now);
        while self.wrong.front().is_some_and(|at| *at <= now - ATTEMPT_WINDOW_MS) {
            self.wrong.pop_front();
        }
        if self.wrong.len() >= ATTEMPT_LIMIT {
            self.paused_until = Some(now + PAUSE_MS);
            self.wrong.clear();
            log::warn!("machine host: {ATTEMPT_LIMIT} wrong pairing attempts in a minute; pairing paused for a minute");
        }
    }

    /// A new code, ending the one before and any computer waiting on it.
    /// The token's hash is kept; the token goes only to the caller. `Err`
    /// with the end of the pause while pairing is paused. `grant_request_id`:
    /// the account grant the code answers, carried to the computer's record.
    pub(crate) fn create(&mut self, now: i64, grant_request_id: Option<String>) -> Result<(String, i64), i64> {
        if let Some(until) = self.paused_until(now) {
            return Err(until);
        }
        self.end(REFUSED_CODE_INACTIVE);
        let token = crate::relay_e2ee::random_token();
        let expires_at = now + CODE_TTL_MS;
        self.code = Some(LiveCode { token_hash: super::registry::token_hash(&token), expires_at, grant_request_id });
        Ok((token, expires_at))
    }

    /// A token that is not a paired computer's (rules 1, 3 and 4).
    pub(crate) fn ask(&mut self, asking: Asking<'_>, now: i64) -> Decision {
        if self.paused_until(now).is_some() {
            return Decision::Refuse(REFUSED_PAIRING_PAUSED);
        }
        self.tick(now);
        let live = self.code.as_ref().is_some_and(|code| bool::from(code.token_hash.ct_eq(&asking.token_hash)) && code.expires_at > now);
        if !live {
            self.wrong_attempt(now);
            return Decision::Refuse(REFUSED_CODE_INACTIVE);
        }
        if let Some(pending) = &mut self.pending {
            // Only one code is live, so a pending request is this code's.
            if pending.client_key_b64 != asking.client_key_b64 {
                return Decision::Refuse(REFUSED_ANOTHER_COMPUTER);
            }
            pending.waiters += 1;
            return Decision::Wait { request_id: pending.view.request_id.clone(), outcome: pending.outcome.subscribe() };
        }
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let grant_request_id = self.code.as_ref().and_then(|code| code.grant_request_id.clone());
        let (outcome, receiver) = watch::channel(Outcome::Waiting);
        self.pending = Some(Pending {
            view: PendingComputer {
                request_id: request_id.clone(),
                label: asking.label,
                platform: asking.platform,
                fingerprint: asking.fingerprint,
                transport: asking.transport.into(),
                requested_at: now,
                expires_at: now + self.approval_ttl_ms,
            },
            token_hash: asking.token_hash,
            client_key_b64: asking.client_key_b64.into(),
            grant_request_id,
            waiters: 1,
            outcome,
        });
        log::info!("machine host: a computer asks to operate this machine; waiting for Allow");
        Decision::Wait { request_id, outcome: receiver }
    }

    /// What Allow writes for `request_id`, while it still waits.
    pub(crate) fn approving(&mut self, request_id: &str, now: i64) -> Option<Approving> {
        self.tick(now);
        let pending = self.pending.as_ref().filter(|pending| pending.view.request_id == request_id)?;
        Some(Approving {
            request_id: pending.view.request_id.clone(),
            token_hash: pending.token_hash,
            client_key_b64: pending.client_key_b64.clone(),
            label: pending.view.label.clone(),
            platform: pending.view.platform.clone(),
            fingerprint: pending.view.fingerprint.clone(),
            grant_request_id: pending.grant_request_id.clone(),
        })
    }

    /// The record is written: spend the code and let the computer in.
    /// False when the request ended meanwhile.
    pub(crate) fn approved(&mut self, request_id: &str) -> bool {
        if !self.pending.as_ref().is_some_and(|pending| pending.view.request_id == request_id) {
            return false;
        }
        let pending = self.pending.take().expect("checked above");
        self.code = None;
        let _ = pending.outcome.send(Outcome::Approved);
        true
    }

    /// "Don't allow", no answer in time, or the asking connection closing:
    /// end the code and tell every waiting connection. Whether it was waiting.
    pub(crate) fn decline(&mut self, request_id: &str) -> bool {
        if !self.pending.as_ref().is_some_and(|pending| pending.view.request_id == request_id) {
            return false;
        }
        self.end(REFUSED_NOT_APPROVED);
        true
    }

    /// One waiting connection closed; the last one declines the request.
    pub(crate) fn leave(&mut self, request_id: &str) -> bool {
        let Some(pending) = self.pending.as_mut().filter(|pending| pending.view.request_id == request_id) else { return false };
        pending.waiters = pending.waiters.saturating_sub(1);
        pending.waiters == 0 && self.decline(request_id)
    }

    /// The switch went off, or a newer code: nothing stays live.
    pub(crate) fn end(&mut self, reason: &'static str) {
        self.code = None;
        if let Some(pending) = self.pending.take() {
            let _ = pending.outcome.send(Outcome::Refused(reason));
        }
    }

    /// Drop what expired. Whether anything did.
    pub(crate) fn tick(&mut self, now: i64) -> bool {
        let mut changed = false;
        if self.pending.as_ref().is_some_and(|pending| pending.view.expires_at <= now) {
            // No answer in two minutes is "Don't allow".
            self.end(REFUSED_NOT_APPROVED);
            changed = true;
        }
        // A code's own expiry does not cut a waiting computer short.
        if self.pending.is_none() && self.code.as_ref().is_some_and(|code| code.expires_at <= now) {
            self.code = None;
            changed = true;
        }
        if self.paused_until.is_some_and(|until| until <= now) {
            self.paused_until = None;
            changed = true;
        }
        changed
    }

    /// What the status says: never the code itself.
    pub(crate) fn view(&self, now: i64) -> (Option<PendingComputer>, Option<CodeExpiry>, Option<i64>) {
        let pending = self.pending.as_ref().filter(|pending| pending.view.expires_at > now).map(|pending| pending.view.clone());
        let code = self.code.as_ref().filter(|code| code.expires_at > now || pending.is_some()).map(|code| CodeExpiry { expires_at: code.expires_at });
        (pending, code, self.paused_until(now))
    }

    #[cfg(test)]
    pub(crate) fn expire_code_for_test(&mut self, now: i64) {
        if let Some(code) = &mut self.code {
            code.expires_at = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine_host::registry::token_hash;

    fn asking<'a>(token: &str, key: &'a str) -> Asking<'a> {
        Asking { token_hash: token_hash(token), client_key_b64: key, label: "MacBook".into(), platform: Some("macos".into()), fingerprint: "AAAA·BBBB·CCCC·DDDD".into(), transport: "direct" }
    }

    fn waits(decision: Decision) -> (String, watch::Receiver<Outcome>) {
        match decision {
            Decision::Wait { request_id, outcome } => (request_id, outcome),
            Decision::Refuse(reason) => panic!("refused: {reason}"),
        }
    }

    fn refused(decision: Decision) -> &'static str {
        match decision {
            Decision::Wait { .. } => panic!("expected a refusal"),
            Decision::Refuse(reason) => reason,
        }
    }

    #[test]
    fn a_code_starts_one_approval_that_spends_it() {
        let mut pairing = Pairing::default();
        let (token, expires_at) = pairing.create(1_000, None).unwrap();
        assert_eq!(expires_at, 1_000 + CODE_TTL_MS);
        assert_eq!(pairing.view(1_000).1, Some(CodeExpiry { expires_at }));
        let (request, outcome) = waits(pairing.ask(asking(&token, "key-a"), 2_000));
        let (again, _) = waits(pairing.ask(asking(&token, "key-a"), 2_100));
        assert_eq!(again, request, "the same computer shares its request");
        assert_eq!(refused(pairing.ask(asking(&token, "key-b"), 2_200)), REFUSED_ANOTHER_COMPUTER);
        let pending = pairing.view(2_200).0.unwrap();
        assert_eq!((pending.label.as_str(), pending.expires_at), ("MacBook", 2_000 + APPROVAL_TTL_MS));
        let approving = pairing.approving(&request, 3_000).unwrap();
        assert_eq!(approving.client_key_b64, "key-a");
        assert_eq!(approving.grant_request_id, None, "a code made on this Mac answers no grant");
        assert_eq!(approving.token_hash, token_hash(&token));
        assert!(pairing.approved(&request));
        assert_eq!(*outcome.borrow(), Outcome::Approved);
        assert_eq!(pairing.view(3_000), (None, None, None), "the code is spent");
        assert_eq!(refused(pairing.ask(asking(&token, "key-c"), 3_100)), REFUSED_CODE_INACTIVE, "it works once");
    }

    #[test]
    fn decline_timeout_and_closing_end_the_code() {
        let mut pairing = Pairing::default();
        let (token, _) = pairing.create(0, None).unwrap();
        let (request, outcome) = waits(pairing.ask(asking(&token, "k"), 10));
        assert!(pairing.decline(&request));
        assert_eq!(*outcome.borrow(), Outcome::Refused(REFUSED_NOT_APPROVED));
        assert_eq!(refused(pairing.ask(asking(&token, "k"), 20)), REFUSED_CODE_INACTIVE);

        let (token, _) = pairing.create(100, None).unwrap();
        let (_, outcome) = waits(pairing.ask(asking(&token, "k"), 100));
        assert!(pairing.tick(100 + APPROVAL_TTL_MS), "no answer in two minutes");
        assert_eq!(*outcome.borrow(), Outcome::Refused(REFUSED_NOT_APPROVED));
        assert_eq!(pairing.view(100 + APPROVAL_TTL_MS), (None, None, None));

        let (token, _) = pairing.create(200_000, None).unwrap();
        let (request, _) = waits(pairing.ask(asking(&token, "k"), 200_000));
        let _ = waits(pairing.ask(asking(&token, "k"), 200_001));
        assert!(!pairing.leave(&request), "another connection still waits");
        assert!(pairing.leave(&request), "the last one closing declines");
        assert!(pairing.approving(&request, 200_002).is_none());

        let (old, _) = pairing.create(300_000, None).unwrap();
        let (_, outcome) = waits(pairing.ask(asking(&old, "k"), 300_000));
        let (_, _) = pairing.create(300_001, None).unwrap();
        assert_eq!(*outcome.borrow(), Outcome::Refused(REFUSED_CODE_INACTIVE), "a newer code ends the one before");
        assert_eq!(refused(pairing.ask(asking(&old, "k"), 300_002)), REFUSED_CODE_INACTIVE);
    }

    #[test]
    fn five_wrong_attempts_in_a_minute_pause_pairing_for_a_minute() {
        let mut pairing = Pairing::default();
        let (token, _) = pairing.create(0, None).unwrap();
        // Four, then one more after the first has left the window: no pause.
        for at in [0, 10, 20, 30] {
            assert_eq!(refused(pairing.ask(asking("wrong", "k"), at)), REFUSED_CODE_INACTIVE);
        }
        assert_eq!(refused(pairing.ask(asking("wrong", "k"), ATTEMPT_WINDOW_MS)), REFUSED_CODE_INACTIVE);
        assert_eq!(pairing.paused_until(ATTEMPT_WINDOW_MS), None);
        let fifth = ATTEMPT_WINDOW_MS + 5;
        assert_eq!(refused(pairing.ask(asking("wrong", "k"), fifth)), REFUSED_CODE_INACTIVE);
        assert_eq!(pairing.paused_until(fifth), Some(fifth + PAUSE_MS));
        assert_eq!(pairing.view(fifth).2, Some(fifth + PAUSE_MS));
        assert_eq!(refused(pairing.ask(asking(&token, "k"), fifth + 1)), REFUSED_PAIRING_PAUSED, "even the live code");
        assert_eq!(pairing.create(fifth + 1, None).unwrap_err(), fifth + PAUSE_MS);
        assert!(pairing.create(fifth + PAUSE_MS, None).is_ok(), "a minute later");
        assert_eq!(pairing.view(fifth + PAUSE_MS).2, None);
    }

    #[test]
    fn a_code_made_for_a_grant_carries_it_to_allow() {
        let mut pairing = Pairing::default();
        let (token, _) = pairing.create(0, Some("grant-1".into())).unwrap();
        let (request, _) = waits(pairing.ask(asking(&token, "k"), 10));
        assert_eq!(pairing.approving(&request, 20).unwrap().grant_request_id.as_deref(), Some("grant-1"));
        // A newer code for no grant replaces it, and its computer has none.
        let (token, _) = pairing.create(30, None).unwrap();
        let (request, _) = waits(pairing.ask(asking(&token, "k"), 40));
        assert_eq!(pairing.approving(&request, 50).unwrap().grant_request_id, None);
    }

    #[test]
    fn an_expired_code_is_a_wrong_attempt() {
        let mut pairing = Pairing::default();
        let (token, expires_at) = pairing.create(0, None).unwrap();
        assert_eq!(refused(pairing.ask(asking(&token, "k"), expires_at)), REFUSED_CODE_INACTIVE);
        assert_eq!(pairing.wrong.len(), 1);
        assert_eq!(pairing.view(expires_at).1, None);
    }
}
