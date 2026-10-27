//! `terminalx issues view/comment/status/assign/label/create` (PRO-100).
//!
//! Reads answer at once. A write changes shared state on GitHub or Linear
//! and may notify other people, so every write is put to the person first,
//! in a bounded review in the main window: its default button refuses, it expires, and
//! computer use is paused while it is on screen. The app cannot tell an
//! agent's request from the person's own (they share the control token), so
//! it never tries. A project may let comments and status moves on its own
//! GitHub repository's issues go ahead without a question; assigning,
//! labels, new issues and anything on Linear always ask.

use std::sync::Arc;

use serde_json::Value;

use crate::cloud_control::Answer;
use crate::control::ControlError;

/// What the person reviews before an issue write.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub session_id: Option<String>,
    pub session_title: Option<String>,
    pub project: String,
    pub target: String,
    pub summary: String,
    pub description: Option<String>,
    pub title: String,
    pub message: String,
    /// The one button that agrees.
    pub agree: String,
}

/// Presents a [`Question`] and waits for the answer. Only the desktop app has one.
pub type Ask = Arc<dyn Fn(Question) -> Answer + Send + Sync>;

/// Where the CLI says it ran. It is the caller's own claim: anything that
/// can reach the socket can write any of it, so it is shown and never
/// trusted. Every write is asked whoever claims to send it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Caller {
    pub session: Option<String>,
    pub cwd: Option<String>,
}

impl Caller {
    pub fn of(params: &Value) -> Self {
        let caller = params.get("caller").filter(|caller| caller.is_object());
        let text = |name: &str| caller.and_then(|caller| caller.get(name)).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        Self { session: text("session"), cwd: text("cwd") }
    }
}

/// A change to an issue, as the person is asked about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Write {
    Comment { body: String },
    Status { to: String },
    Assign { to: Vec<String>, me: bool },
    Label { add: Vec<String>, remove: Vec<String> },
    Create { title: String, body: Option<String> },
}

impl Write {
    /// Whether the project's "without asking" switch covers this write.
    fn routine(&self) -> bool {
        matches!(self, Self::Comment { .. } | Self::Status { .. })
    }

    fn agree(&self) -> &'static str {
        match self {
            Self::Comment { .. } => "Post comment",
            Self::Status { .. } => "Change status",
            Self::Assign { .. } => "Change assignees",
            Self::Label { .. } => "Change labels",
            Self::Create { .. } => "Create issue",
        }
    }

    /// The action and its text, as the question shows them.
    fn describe(&self, issue: &str) -> String {
        let names = |names: &[String]| names.iter().map(|name| format!("\u{201c}{}\u{201d}", one_line(name, 80))).collect::<Vec<_>>().join(", ");
        match self {
            Self::Comment { body } => format!("post this comment on {issue}:\n\n{}", quoted(body)),
            Self::Status { to } => format!("move {issue} to \u{201c}{}\u{201d}.", one_line(to, 80)),
            Self::Assign { me: true, .. } => format!("assign {issue} to you."),
            Self::Assign { to, .. } if to.is_empty() => format!("remove everyone assigned to {issue}."),
            Self::Assign { to, .. } => format!("assign {issue} to {}.", names(to)),
            Self::Label { add, remove } => {
                let mut parts = Vec::new();
                if !add.is_empty() {
                    parts.push(format!("add {}", names(add)));
                }
                if !remove.is_empty() {
                    parts.push(format!("remove {}", names(remove)));
                }
                format!("change the labels of {issue}: {}.", parts.join(" and "))
            }
            Self::Create { title, body } => {
                let mut text = format!("create the issue \u{201c}{}\u{201d} in {issue}", one_line(title, SHOWN_CHARS));
                match body.as_deref().filter(|body| !body.trim().is_empty()) {
                    Some(body) => text.push_str(&format!(" with this description:\n\n{}", quoted(body))),
                    None => text.push('.'),
                }
                text
            }
        }
    }

    /// Text the question would have to cut. What is asked about is posted
    /// whole, so it must be shown whole: a longer one is refused instead.
    fn too_long(&self) -> Option<&'static str> {
        let long = |text: &str| text.chars().count() > SHOWN_CHARS || text.trim().lines().count() > SHOWN_LINES;
        match self {
            Self::Comment { body } if long(body) => Some("comment"),
            Self::Create { title, .. } if long(title) => Some("title"),
            Self::Create { body: Some(body), .. } if long(body) => Some("description"),
            _ => None,
        }
    }
}

/// The longest comment, title or description the question shows; it is
/// shown in full or the write is refused.
const SHOWN_CHARS: usize = 4000;
/// Keep the existing review size limit even though the details now scroll.
const SHOWN_LINES: usize = 40;

/// A character that changes how the text around it reads without showing
/// itself: bidirectional overrides and isolates, zero-width characters and
/// other format characters. The question names them instead.
fn invisible(ch: char) -> bool {
    matches!(ch,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{2028}' | '\u{2029}' | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF9}'..='\u{FFFB}'
        | '\u{E0000}'..='\u{E007F}')
}

/// `text` with every control and invisible character written out (`⟨U+202E⟩`);
/// a tab is spaces and, when `lines`, a newline stays a newline.
fn visible(text: &str, lines: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\n' if lines => out.push('\n'),
            '\t' => out.push_str("    "),
            '\r' if lines => {}
            ch if ch.is_control() || invisible(ch) => out.push_str(&format!("\u{27e8}U+{:04X}\u{27e9}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out
}

/// A comment or description as the question shows it: whole, every line
/// behind a bar so none of it reads as the question's own words.
fn quoted(text: &str) -> String {
    visible(text.trim_end(), true).trim_start_matches('\n').lines().map(|line| format!("\u{2503} {line}")).collect::<Vec<_>>().join("\n")
}

fn one_line(text: &str, limit: usize) -> String {
    let flat = visible(&text.split_whitespace().collect::<Vec<_>>().join(" "), false);
    if flat.chars().count() <= limit {
        return flat;
    }
    format!("{}\u{2026}", flat.chars().take(limit).collect::<String>())
}

/// What a write is about, for the question.
pub struct Subject<'a> {
    /// `#12` or `PRO-42`, with its title when known; the repository or team for a new issue.
    pub issue: &'a str,
    pub provider: &'a str,
    pub project_name: &'a str,
    /// The project lets comments and status moves go ahead without a
    /// question, and the issue verifiably belongs to it (see [`in_project`]).
    pub routine_allowed: bool,
    /// The session the request says it comes from. Claimed, so only shown.
    pub session_title: Option<&'a str>,
    pub session_id: Option<&'a str>,
}

/// Whether the project's switch may apply to an issue: only a GitHub issue
/// read from the project's own repository. A Linear key reaches every team
/// of the workspace and a project names none, so a Linear issue is never
/// the project's to wave through.
pub fn in_project(issue_repo: Option<&str>, project_repo: Option<&str>) -> bool {
    matches!((issue_repo, project_repo), (Some(issue), Some(project)) if issue.eq_ignore_ascii_case(project))
}

pub fn question(write: &Write, subject: &Subject) -> Question {
    let provider = if subject.provider == "linear" { "Linear" } else { "GitHub" };
    let project = one_line(subject.project_name, 80);
    let who = match subject.session_title {
        Some(title) => format!("A terminalx command in {project}, which says it comes from the session \u{201c}{}\u{201d},", one_line(title, 80)),
        None => format!("A terminalx command in {project}"),
    };
    let description = match write {
        Write::Comment { body } | Write::Create { body: Some(body), .. } => Some(visible(body, true)),
        _ => None,
    };
    let summary = match write {
        Write::Create { title, .. } => Write::Create { title: title.clone(), body: None }.describe(subject.issue),
        Write::Comment { .. } => format!("Post comment on {}", subject.issue),
        _ => write.describe(subject.issue),
    };
    Question {
        session_id: subject.session_id.map(str::to_string),
        session_title: subject.session_title.map(|s| one_line(s, 80)),
        project,
        target: visible(subject.issue, false),
        summary,
        description,
        title: format!("{provider} issue request"),
        message: format!("{who} asks to {}\n\nThis acts on {provider}, where other people can see it and may be notified. If you did not ask an agent for this, refuse.", write.describe(subject.issue)),
        agree: write.agree().to_string(),
    }
}

/// Lets `write` go ahead, or says why it may not. Only a comment or status
/// move that the project allows goes ahead without a question.
pub fn authorize(write: &Write, subject: &Subject, ask: Option<&Ask>) -> Result<(), ControlError> {
    if write.routine() && subject.routine_allowed {
        return Ok(());
    }
    if let Some(what) = write.too_long() {
        return Err(ControlError::new(
            "invalid_arguments",
            format!("The {what} is longer than {SHOWN_CHARS} characters or {SHOWN_LINES} lines, too long to show the person in full before it is posted. Nothing was changed."),
            Some(format!("Shorten the {what} to at most {SHOWN_CHARS} characters and {SHOWN_LINES} lines, link to the details instead, or ask the person to post it in the app.")),
        ));
    }
    let Some(ask) = ask else {
        return Err(ControlError::new(
            "confirmation_unavailable",
            "Changing an issue from the command line needs the person's answer, and this runtime has no window to ask in. Nothing was changed.",
            Some("Ask the person to make the change, or run the command in the TerminalX desktop app.".to_string()),
        ));
    };
    refusal(ask(question(write, subject)), subject.issue)
}

fn refusal(answer: Answer, issue: &str) -> Result<(), ControlError> {
    let stop = "Do not retry it. Tell the person what you wanted to change and why, and let them decide.".to_string();
    let (code, message, recovery) = match answer {
        Answer::Accepted => return Ok(()),
        Answer::Declined => ("declined", format!("The person refused the change to {issue}. Nothing was changed."), stop),
        Answer::Expired => ("expired", format!("The person did not answer in time, so the change to {issue} was dropped. Nothing was changed."), stop),
        Answer::Busy => ("busy", format!("Another question is waiting for the person, so the change to {issue} was not asked. Nothing was changed."), "Wait for the person to answer it, then try once more.".to_string()),
        Answer::Backoff(seconds) => (
            "backoff",
            format!("The person refused or left a question unanswered a moment ago; no new question is shown for {seconds} s. Nothing was changed on {issue}."),
            stop,
        ),
    };
    Err(ControlError::new(code, message, Some(recovery)))
}

/// The one state `to` names, by its name ignoring case. Nothing is guessed:
/// no state, or more than one, is an error listing the states there are.
pub fn pick_state<'a, T>(states: &'a [T], name: impl Fn(&T) -> &str, to: &str) -> Result<&'a T, ControlError> {
    pick("state", "states", states, |state| vec![name(state)], to)
}

/// The one item `wanted` names by any of its `names`, ignoring case; never a
/// prefix or a near miss. `what` and `all` are the item's word, alone and plural.
fn pick<'a, T>(what: &str, all: &str, items: &'a [T], names: impl Fn(&T) -> Vec<&str>, wanted: &str) -> Result<&'a T, ControlError> {
    let wanted = wanted.trim();
    let found: Vec<&T> = items.iter().filter(|item| names(item).iter().any(|name| same_name(name, wanted))).collect();
    let valid = || {
        let mut shown: Vec<String> = items.iter().take(LISTED).map(|item| format!("\u{201c}{}\u{201d}", names(item).first().copied().unwrap_or_default())).collect();
        if items.len() > LISTED {
            shown.push(format!("and {} more", items.len() - LISTED));
        }
        if shown.is_empty() { "none".to_string() } else { shown.join(", ") }
    };
    match found.as_slice() {
        [one] => Ok(one),
        [] => Err(ControlError::new("invalid_arguments", format!("No {what} is named \u{201c}{wanted}\u{201d}. The {all} are {}.", valid()), Some(format!("Use one of the listed {all} exactly.")))),
        _ => Err(ControlError::new(
            "ambiguous_selector",
            format!("More than one {what} is named \u{201c}{wanted}\u{201d}, so nothing is changed. The {all} are {}.", valid()),
            Some(format!("Ask the person which {what} is meant.")),
        )),
    }
}

/// Names equal ignoring case, in any script: \u{201c}ÉTAT\u{201d} names \u{201c}état\u{201d}.
fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// The most names an error lists.
const LISTED: usize = 40;

// ------------------------------------------------------------------ operations

use crate::issue_ops::{CloseReason, IssueComment, IssueCreate, IssueDetails, IssueOpError, IssueOptions, OpResult, Provider, StateChange};
use crate::issues::IssueTeam;
use serde_json::json;

/// What the commands need from GitHub or Linear: the contract's operations
/// (`crate::issue_ops`) for one project's repository or the Linear key, and
/// two reads of their own. Tests answer with a fake.
pub trait Backend {
    fn provider(&self) -> Provider;
    fn details(&self, id: &str) -> OpResult<IssueDetails>;
    /// Every comment, oldest first.
    fn comments(&self, id: &str) -> OpResult<Vec<IssueComment>>;
    fn options(&self, id: Option<&str>, team_id: Option<&str>) -> OpResult<IssueOptions>;
    fn comment_add(&self, id: &str, body: &str) -> OpResult<IssueComment>;
    fn set_state(&self, id: &str, change: &StateChange) -> OpResult<IssueDetails>;
    fn set_assignees(&self, id: &str, assignees: &[String]) -> OpResult<IssueDetails>;
    fn set_labels(&self, id: &str, labels: &[String]) -> OpResult<IssueDetails>;
    fn create(&self, input: &IssueCreate) -> OpResult<IssueDetails>;
    /// Whoever the credentials belong to, as `set_assignees` takes them.
    fn viewer(&self) -> OpResult<String>;
    /// Linear's teams; GitHub has none.
    fn teams(&self) -> OpResult<Vec<IssueTeam>>;
    /// Where a new issue goes, for the question: `owner/repo` on GitHub.
    fn place(&self) -> String;
}

/// The most comment pages `view --comments` reads.
const COMMENT_PAGES: usize = 20;

pub struct Live(pub crate::issue_ops::Target);

impl Backend for Live {
    fn provider(&self) -> Provider {
        self.0.provider()
    }
    fn details(&self, id: &str) -> OpResult<IssueDetails> {
        crate::issue_ops::details(&self.0, id)
    }
    fn comments(&self, id: &str) -> OpResult<Vec<IssueComment>> {
        let mut all = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..COMMENT_PAGES {
            let page = crate::issue_ops::comments(&self.0, id, cursor.as_deref())?;
            all.extend(page.comments);
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        Ok(all)
    }
    fn options(&self, id: Option<&str>, team_id: Option<&str>) -> OpResult<IssueOptions> {
        crate::issue_ops::options(&self.0, id, team_id, false)
    }
    fn comment_add(&self, id: &str, body: &str) -> OpResult<IssueComment> {
        crate::issue_ops::comment_add(&self.0, id, body)
    }
    fn set_state(&self, id: &str, change: &StateChange) -> OpResult<IssueDetails> {
        crate::issue_ops::set_state(&self.0, id, change)
    }
    fn set_assignees(&self, id: &str, assignees: &[String]) -> OpResult<IssueDetails> {
        crate::issue_ops::set_assignees(&self.0, id, assignees)
    }
    fn set_labels(&self, id: &str, labels: &[String]) -> OpResult<IssueDetails> {
        crate::issue_ops::set_labels(&self.0, id, labels)
    }
    fn create(&self, input: &IssueCreate) -> OpResult<IssueDetails> {
        crate::issue_ops::create(&self.0, input)
    }
    fn viewer(&self) -> OpResult<String> {
        use crate::issue_ops::{IssueOpErrorKind, Target};
        let unknown = || IssueOpError::with_message(IssueOpErrorKind::NotSignedIn, "Could not tell whose account this is, so --me cannot be used. Name the person with --to instead.");
        match &self.0 {
            Target::Github { cwd, .. } => {
                let user = crate::issue_ops::github::gh_api(cwd, "GET", "user", None)?;
                user["login"].as_str().map(str::to_string).ok_or_else(unknown)
            }
            Target::Linear { key } => crate::issues::linear_viewer_id(key).map_err(|_| unknown()),
        }
    }
    fn teams(&self) -> OpResult<Vec<IssueTeam>> {
        match &self.0 {
            crate::issue_ops::Target::Github { .. } => Ok(Vec::new()),
            crate::issue_ops::Target::Linear { key } => crate::issues::linear_teams(key).map_err(|_| crate::issue_ops::IssueOpError::new(crate::issue_ops::IssueOpErrorKind::Network, Provider::Linear)),
        }
    }
    fn place(&self) -> String {
        match &self.0 {
            crate::issue_ops::Target::Github { repo, .. } => repo.clone(),
            crate::issue_ops::Target::Linear { .. } => "Linear".into(),
        }
    }
}

/// A provider failure as the CLI reports it: the kind is the code and the
/// message is the contract's fixed one, never the provider's reply.
pub fn op_error(error: IssueOpError) -> ControlError {
    let code = serde_json::to_value(error.kind).ok().and_then(|kind| kind.as_str().map(str::to_string)).unwrap_or_else(|| "other".into());
    let recovery = match code.as_str() {
        "rate_limited" | "network" => "Wait a minute and try once more.",
        "conflict" => "Read the issue again with terminalx issues view, then decide whether the change still applies.",
        "invalid" | "unsupported" => "Read the message and correct the command; see terminalx skills get terminalx-cli.",
        _ => "Tell the person; do not retry with other credentials.",
    };
    ControlError::new(&code, error.message, Some(recovery.to_string()))
}

/// Asks the person when it must (see [`authorize`]). It is given what names
/// the issue (or, for a new issue, where it goes) and the GitHub repository
/// the issue was read from, if any.
pub type Gate<'a> = dyn Fn(&Write, &str, Option<&str>) -> Result<(), ControlError> + 'a;

/// Run one `issues.<command>` against `backend`. `id` is what
/// `parse_issue_reference` read from the command line; `create` has none.
pub fn run(command: &str, params: &Value, id: Option<&str>, backend: &dyn Backend, gate: &Gate) -> Result<Value, ControlError> {
    let provider = backend.provider();
    if command == "create" {
        return create(params, backend, gate);
    }
    let id = id.ok_or_else(|| ControlError::invalid("Missing issue."))?;
    // Read first: the question names the issue, and a write starts from what it holds now.
    let issue = backend.details(id).map_err(op_error)?;
    let subject = format!("{} (\u{201c}{}\u{201d})", issue.issue.identifier, one_line(&issue.issue.title, 120));
    // The repository GitHub says the issue is in, from its own address, not
    // the one it was asked in: a transferred issue answers from its new home.
    let issue_repo = if provider == Provider::Github { crate::issues::github_issue_url_repo(&issue.issue.url) } else { None };
    let repo = issue_repo.as_deref();
    let text = |name: &str| params.get(name).and_then(Value::as_str).map(str::to_string);
    let list = |name: &str| params.get(name).and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
    let reread = |details: IssueDetails| Ok(json!({ "issue": details }));
    let id = issue.issue.id.as_str();
    match command {
        "view" => {
            let mut answer = json!({ "issue": issue });
            if params.get("comments").and_then(Value::as_bool) == Some(true) {
                answer["comments"] = json!(backend.comments(id).map_err(op_error)?);
            }
            Ok(answer)
        }
        "comment" => {
            let body = text("body").filter(|body| !body.trim().is_empty()).ok_or_else(|| ControlError::invalid("The comment is empty."))?;
            gate(&Write::Comment { body: body.clone() }, &subject, repo)?;
            Ok(json!({ "comment": backend.comment_add(id, &body).map_err(op_error)? }))
        }
        "status" => {
            let to = text("to").unwrap_or_default();
            let (change, named) = match provider {
                Provider::Github => {
                    let state = *pick_state(&["open", "closed"], |state| state, &to)?;
                    let reason = match text("reason").as_deref() {
                        Some("not_planned") => CloseReason::NotPlanned,
                        Some("completed") | None => CloseReason::Completed,
                        Some(other) => return Err(ControlError::invalid(format!("--reason takes completed or not_planned, not {other}."))),
                    };
                    if state == "open" {
                        if text("reason").is_some() {
                            return Err(ControlError::invalid("--reason says why an issue is closed; it does not apply to open."));
                        }
                        (StateChange::Reopen, "open".to_string())
                    } else {
                        let why = if reason == CloseReason::NotPlanned { "closed as not planned" } else { "closed as completed" };
                        (StateChange::Close { reason }, why.to_string())
                    }
                }
                Provider::Linear => {
                    let options = backend.options(Some(id), None).map_err(op_error)?;
                    let mut states = options.states;
                    states.sort_by(|a, b| a.position.total_cmp(&b.position));
                    let state = pick_state(&states, |state| &state.name, &to)?;
                    (StateChange::WorkflowState { state_id: state.id.clone() }, state.name.clone())
                }
            };
            gate(&Write::Status { to: named }, &subject, repo)?;
            reread(backend.set_state(id, &change).map_err(op_error)?)
        }
        "assign" => {
            let me = params.get("me").and_then(Value::as_bool) == Some(true);
            let none = params.get("none").and_then(Value::as_bool) == Some(true);
            let wanted = list("to");
            let (ids, names) = if none {
                (Vec::new(), Vec::new())
            } else if me {
                (vec![backend.viewer().map_err(op_error)?], Vec::new())
            } else {
                let members = backend.options(Some(id), None).map_err(op_error)?.members;
                let mut ids = Vec::new();
                let mut names = Vec::new();
                for person in &wanted {
                    // GitHub takes any login; one the repository lists is checked here first.
                    if provider == Provider::Github && members.is_empty() {
                        ids.push(person.trim_start_matches('@').to_string());
                        names.push(person.trim_start_matches('@').to_string());
                        continue;
                    }
                    let login = person.trim_start_matches('@');
                    let member = pick("person", "people who can be assigned", &members, |user| {
                        let mut names = vec![user.login.as_deref().unwrap_or(user.name.as_str()), user.name.as_str(), user.id.as_str()];
                        names.dedup();
                        names
                    }, login)?;
                    ids.push(member.id.clone());
                    names.push(member.login.clone().unwrap_or_else(|| member.name.clone()));
                }
                (ids, names)
            };
            gate(&Write::Assign { to: names, me }, &subject, repo)?;
            reread(backend.set_assignees(id, &ids).map_err(op_error)?)
        }
        "label" => {
            let (add, remove) = (list("add"), list("remove"));
            let options = backend.options(Some(id), None).map_err(op_error)?;
            let labels: Vec<_> = options.labels.into_iter().filter(|label| !label.is_group).collect();
            // The issue's labels by the id `set_labels` takes.
            let mut kept: Vec<(String, String)> = issue.issue.labels.iter().map(|label| {
                let known = labels.iter().find(|option| same_name(&option.name, &label.name));
                let id = label.id.clone().or_else(|| known.map(|option| option.id.clone())).unwrap_or_else(|| label.name.clone());
                (id, label.name.clone())
            }).collect();
            let (mut added, mut removed) = (Vec::new(), Vec::new());
            for name in &add {
                let label = pick("label", "labels", &labels, |label| vec![label.name.as_str()], name)?;
                if !kept.iter().any(|(id, _)| *id == label.id) {
                    kept.push((label.id.clone(), label.name.clone()));
                    added.push(label.name.clone());
                }
            }
            for name in &remove {
                if let Some(position) = kept.iter().position(|(_, kept)| same_name(kept, name)) {
                    removed.push(kept.remove(position).1);
                }
            }
            if added.is_empty() && removed.is_empty() {
                // Nothing would change: nobody is asked and nothing is written.
                return Ok(json!({ "issue": issue }));
            }
            gate(&Write::Label { add: added, remove: removed }, &subject, repo)?;
            let ids: Vec<String> = kept.into_iter().map(|(id, _)| id).collect();
            reread(backend.set_labels(id, &ids).map_err(op_error)?)
        }
        other => Err(ControlError::invalid(format!("Unknown issues command {other}."))),
    }
}

fn create(params: &Value, backend: &dyn Backend, gate: &Gate) -> Result<Value, ControlError> {
    let text = |name: &str| params.get(name).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    let list = |name: &str| params.get(name).and_then(Value::as_array).map(|values| values.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()).unwrap_or_default();
    let title = text("title").ok_or_else(|| ControlError::invalid("--title cannot be empty."))?;
    let description = params.get("body").and_then(Value::as_str).unwrap_or_default().to_string();
    let provider = backend.provider();
    let (team, place) = match provider {
        Provider::Github => {
            if text("team").is_some() || text("state").is_some() || params.get("priority").is_some_and(|priority| !priority.is_null()) {
                return Err(ControlError::invalid("--team, --state and --priority are for Linear; a GitHub issue starts open, in the project's repository."));
            }
            (None, backend.place())
        }
        Provider::Linear => {
            let teams = backend.teams().map_err(op_error)?;
            let team = match text("team") {
                Some(named) => pick("team", "teams", &teams, |team| vec![team.key.as_str(), team.name.as_str(), team.id.as_str()], &named)?.clone(),
                None if teams.len() == 1 => teams[0].clone(),
                None => return Err(ControlError::invalid(format!("A Linear issue is created in a team: pass --team with one of {}.", teams.iter().map(|team| team.key.as_str()).collect::<Vec<_>>().join(", ")))),
            };
            let place = format!("the Linear team {}", team.key);
            (Some(team), place)
        }
    };
    let (assignees, labels) = (list("assignees"), list("labels"));
    let needs_options = !assignees.is_empty() || !labels.is_empty() || text("state").is_some();
    let options = if needs_options { Some(backend.options(None, team.as_ref().map(|team| team.id.as_str())).map_err(op_error)?) } else { None };
    let mut input = IssueCreate { team_id: team.map(|team| team.id), title: title.clone(), description: description.clone(), ..IssueCreate::default() };
    if let Some(options) = &options {
        for person in &assignees {
            let login = person.trim_start_matches('@');
            if provider == Provider::Github && options.members.is_empty() {
                input.assignees.push(login.to_string());
            } else {
                input.assignees.push(pick("person", "people who can be assigned", &options.members, |user| vec![user.login.as_deref().unwrap_or(user.name.as_str()), user.name.as_str(), user.id.as_str()], login)?.id.clone());
            }
        }
        let usable: Vec<_> = options.labels.iter().filter(|label| !label.is_group).cloned().collect();
        for name in &labels {
            input.labels.push(pick("label", "labels", &usable, |label| vec![label.name.as_str()], name)?.id.clone());
        }
        if let Some(state) = text("state") {
            input.state_id = Some(pick_state(&options.states, |state| &state.name, &state)?.id.clone());
        }
    }
    input.priority = params.get("priority").and_then(Value::as_u64).map(|priority| priority.min(4) as u8);
    gate(&Write::Create { title, body: (!description.trim().is_empty()).then_some(description) }, &place, None)?;
    Ok(json!({ "issue": backend.create(&input).map_err(op_error)? }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    fn subject(allows: bool) -> Subject<'static> {
        Subject { issue: "PRO-42 (Fix the login)", provider: "linear", project_name: "raccoon", routine_allowed: allows, session_id: Some("session-1"), session_title: Some("Fix login") }
    }

    /// An `Ask` that records each question and answers `answer`.
    fn asking(answer: fn() -> Answer) -> (Ask, Arc<Mutex<Vec<Question>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        (Arc::new(move |question| {
            seen.lock().unwrap().push(question);
            answer()
        }), asked)
    }

    #[test]
    fn the_caller_is_read_for_display_and_nothing_it_claims_decides() {
        let claimed = Caller::of(&json!({"caller": {"session": "s1", "agentEnvironment": false, "cwd": "/repo"}}));
        assert_eq!(claimed, Caller { session: Some("s1".into()), cwd: Some("/repo".into()) });
        assert_eq!(Caller::of(&json!({"caller": {"session": "  "}})), Caller::default());
        assert_eq!(Caller::of(&json!({"caller": "me"})), Caller::default());
    }

    #[test]
    fn a_write_is_asked_and_names_the_issue_the_action_and_the_text() {
        let (ask, asked) = asking(|| Answer::Accepted);
        let write = Write::Comment { body: "Fixed in https://github.com/acme/api/pull/13".into() };
        authorize(&write, &subject(false), Some(&ask)).unwrap();
        let question = asked.lock().unwrap().pop().unwrap();
        assert_eq!((question.title.as_str(), question.agree.as_str()), ("Linear issue request", "Post comment"));
        assert!(question.message.starts_with("A terminalx command in raccoon, which says it comes from the session \u{201c}Fix login\u{201d}, asks to post this comment on PRO-42 (Fix the login):"), "{}", question.message);
        assert!(question.message.contains("\u{2503} Fixed in https://github.com/acme/api/pull/13"));

        for (write, agree, says) in [
            (Write::Status { to: "In Review".into() }, "Change status", "move PRO-42 (Fix the login) to \u{201c}In Review\u{201d}."),
            (Write::Assign { to: vec!["alice".into(), "bob".into()], me: false }, "Change assignees", "assign PRO-42 (Fix the login) to \u{201c}alice\u{201d}, \u{201c}bob\u{201d}."),
            (Write::Assign { to: vec![], me: true }, "Change assignees", "assign PRO-42 (Fix the login) to you."),
            (Write::Assign { to: vec![], me: false }, "Change assignees", "remove everyone assigned to PRO-42 (Fix the login)."),
            (Write::Label { add: vec!["bug".into()], remove: vec!["triage".into()] }, "Change labels", "change the labels of PRO-42 (Fix the login): add \u{201c}bug\u{201d} and remove \u{201c}triage\u{201d}."),
            (Write::Create { title: "Flaky test".into(), body: Some("Seen twice.".into()) }, "Create issue", "create the issue \u{201c}Flaky test\u{201d} in PRO-42 (Fix the login) with this description:\n\n\u{2503} Seen twice."),
        ] {
            let question = super::question(&write, &subject(false));
            assert_eq!(question.agree, agree);
            assert!(question.message.contains(says), "{}", question.message);
        }
    }

    #[test]
    fn a_claim_to_be_the_persons_own_shell_is_still_asked() {
        // A frame that says it is no agent's, from no session: the question is shown all the same.
        let caller = Caller::of(&json!({"caller": {"session": null, "tab": null, "agentEnvironment": false, "cwd": "/repo"}}));
        assert_eq!(caller.session, None);
        let shell = Subject { session_title: None, ..subject(false) };
        let (ask, asked) = asking(|| Answer::Declined);
        for write in [Write::Comment { body: "hi".into() }, Write::Assign { to: vec![], me: true }, Write::Create { title: "t".into(), body: None }] {
            assert_eq!(authorize(&write, &shell, Some(&ask)).unwrap_err().code, "declined");
        }
        assert_eq!(asked.lock().unwrap().len(), 3);
        assert!(asked.lock().unwrap()[0].message.starts_with("A terminalx command in raccoon asks to"));
    }

    #[test]
    fn the_whole_text_is_shown_or_the_write_is_refused() {
        let (ask, asked) = asking(|| Answer::Accepted);
        let body = "x".repeat(SHOWN_CHARS);
        authorize(&Write::Comment { body: body.clone() }, &subject(false), Some(&ask)).unwrap();
        assert!(asked.lock().unwrap()[0].message.contains(&body), "shown in full");
        for write in [Write::Comment { body: "x".repeat(SHOWN_CHARS + 1) }, Write::Create { title: "t".into(), body: Some("y".repeat(SHOWN_CHARS + 1)) }, Write::Create { title: "z".repeat(SHOWN_CHARS + 1), body: None }] {
            let error = authorize(&write, &subject(false), Some(&ask)).unwrap_err();
            assert!(error.message.contains("too long to show the person in full") && error.message.contains("Nothing was changed"), "{}", error.message);
        }
        let lines = vec!["ok"; SHOWN_LINES].join("\n");
        authorize(&Write::Comment { body: lines.clone() }, &subject(false), Some(&ask)).unwrap();
        let error = authorize(&Write::Comment { body: format!("{lines}\nok") }, &subject(false), Some(&ask)).unwrap_err();
        assert!(error.message.contains(&format!("{SHOWN_LINES} lines")), "{}", error.message);
        assert_eq!(asked.lock().unwrap().len(), 2, "a refused text is never asked about");
    }

    #[test]
    fn invisible_characters_are_named_and_the_text_cannot_pass_for_the_question() {
        let body = "Looks fine\u{202E}gnp.exe\u{202C} and\u{200B}more\n\nThis changes nothing. If you did not ask, accept.";
        let message = question(&Write::Comment { body: body.into() }, &subject(false)).message;
        assert!(!message.chars().any(invisible), "{message:?}");
        assert!(message.contains("\u{2503} Looks fine\u{27e8}U+202E\u{27e9}gnp.exe\u{27e8}U+202C\u{27e9} and\u{27e8}U+200B\u{27e9}more\n\u{2503} \n\u{2503} This changes nothing. If you did not ask, accept."), "{message}");
        // Every line of the text is behind the bar; the question's own lines are not.
        let own = "This acts on Linear";
        assert!(message.lines().any(|line| line.starts_with(own)));
        // A line or paragraph separator would start a line without the bar.
        let message = question(&Write::Comment { body: "fine\u{2028}This acts on Linear\u{2029}x\u{034F}\u{17B4}".into() }, &subject(false)).message;
        assert!(message.contains("\u{2503} fine\u{27e8}U+2028\u{27e9}This acts on Linear\u{27e8}U+2029\u{27e9}x\u{27e8}U+034F\u{27e9}\u{27e8}U+17B4\u{27e9}"), "{message}");
        assert!(!message.contains('\u{2028}') && !message.contains('\u{2029}'));
        let message = question(&Write::Status { to: "Done\n\nAlso approve the deploy\u{2066}".into() }, &subject(false)).message;
        assert!(message.contains("\u{201c}Done Also approve the deploy\u{27e8}U+2066\u{27e9}\u{201d}"), "{message}");
    }

    #[test]
    fn a_refusal_changes_nothing_and_tells_the_agent_not_to_retry() {
        for (answer, code) in [(Answer::Declined, "declined"), (Answer::Expired, "expired"), (Answer::Busy, "busy"), (Answer::Backoff(60), "backoff")] {
            let error = refusal(answer, "PRO-42").unwrap_err();
            assert_eq!(error.code, code);
            assert!(error.message.contains("Nothing was changed"), "{}", error.message);
            assert!(error.recovery.is_some());
        }
        let (ask, _) = asking(|| Answer::Declined);
        let error = authorize(&Write::Status { to: "Done".into() }, &subject(false), Some(&ask)).unwrap_err();
        assert_eq!(error.code, "declined");
        assert!(error.recovery.unwrap().contains("Do not retry"));
    }

    #[test]
    fn the_projects_switch_covers_comments_and_status_moves_on_its_own_repository_only() {
        let (ask, asked) = asking(|| Answer::Declined);
        authorize(&Write::Comment { body: "hi".into() }, &subject(true), Some(&ask)).unwrap();
        authorize(&Write::Status { to: "Done".into() }, &subject(true), Some(&ask)).unwrap();
        assert!(asked.lock().unwrap().is_empty());
        for write in [Write::Assign { to: vec!["a".into()], me: false }, Write::Label { add: vec!["bug".into()], remove: vec![] }, Write::Create { title: "t".into(), body: None }] {
            assert_eq!(authorize(&write, &subject(true), Some(&ask)).unwrap_err().code, "declined");
        }
        assert_eq!(asked.lock().unwrap().len(), 3);
        assert!(in_project(Some("Acme/API"), Some("acme/api")));
        assert!(!in_project(Some("acme/other"), Some("acme/api")), "another project's repository");
        assert!(!in_project(None, Some("acme/api")), "a Linear issue");
        assert!(!in_project(Some("acme/api"), None), "a project with no GitHub remote");
    }

    #[test]
    fn without_a_window_a_write_is_refused_rather_than_made() {
        let error = authorize(&Write::Comment { body: "hi".into() }, &subject(false), None).unwrap_err();
        assert_eq!(error.code, "confirmation_unavailable");
        assert!(error.message.contains("Nothing was changed"));
        authorize(&Write::Comment { body: "hi".into() }, &subject(true), None).unwrap();
    }

    #[test]
    fn a_state_is_named_exactly_once_or_the_states_are_listed() {
        let states = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"];
        assert_eq!(*pick_state(&states, |state| state, "in review").unwrap(), "In Review");
        assert_eq!(*pick_state(&states, |state| state, "  DONE ").unwrap(), "Done");
        let unknown = pick_state(&states, |state| state, "Review").unwrap_err();
        assert_eq!(unknown.code, "invalid_arguments");
        assert!(unknown.message.contains("No state is named \u{201c}Review\u{201d}"), "{}", unknown.message);
        assert!(unknown.message.contains("\u{201c}Backlog\u{201d}, \u{201c}Todo\u{201d}, \u{201c}In Progress\u{201d}, \u{201c}In Review\u{201d}, \u{201c}Done\u{201d}, \u{201c}Canceled\u{201d}"), "{}", unknown.message);
        // Never a prefix or a near miss.
        assert!(pick_state(&states, |state| state, "In").is_err());
        assert!(pick_state(&states, |state| state, "Cancelled").is_err());
        assert_eq!(*pick_state(&["Écrit", "Fertig"], |state| state, "écrit").unwrap(), "Écrit", "case is ignored beyond ASCII");
        let twice = ["Done", "In Review", "done"];
        let ambiguous = pick_state(&twice, |state| state, "DONE").unwrap_err();
        assert_eq!(ambiguous.code, "ambiguous_selector");
        assert!(ambiguous.message.contains("More than one state is named \u{201c}DONE\u{201d}") && ambiguous.message.contains("\u{201c}done\u{201d}"), "{}", ambiguous.message);
    }

    // ---- the operations, against a fake GitHub or Linear --------------------

    use crate::issue_ops::{IssueOpErrorKind, WorkflowState};
    use std::cell::RefCell;

    struct Fake {
        provider: Provider,
        issue: IssueDetails,
        options: IssueOptions,
        teams: Vec<IssueTeam>,
        /// Every write that reached the provider, in order.
        writes: RefCell<Vec<Value>>,
        fail_with: Option<IssueOpErrorKind>,
    }

    fn issue(provider: &str, id: &str, identifier: &str, labels: &[&str]) -> IssueDetails {
        let kind = if provider == "linear" { Provider::Linear } else { Provider::Github };
        serde_json::from_value(json!({
            "provider": provider, "id": id, "identifier": identifier, "number": 42, "title": "Fix the login",
            "state": "Todo", "stateType": "unstarted", "labels": labels.iter().map(|name| json!({"name": name, "color": ""})).collect::<Vec<_>>(),
            "updatedAt": "2026-10-18T00:00:00Z", "description": "It fails.", "assignees": [], "createdAt": "2026-10-01T00:00:00Z",
            "capabilities": crate::issue_ops::IssueCapabilities::of(kind),
            "repo": (kind == Provider::Github).then_some("acme/api"),
            "url": if kind == Provider::Github { "https://github.com/acme/api/issues/12" } else { "https://linear.app/acme/issue/PRO-42" },
        }))
        .unwrap()
    }

    fn user(id: &str, name: &str, login: Option<&str>) -> crate::issue_ops::IssueUser {
        crate::issue_ops::IssueUser { id: id.into(), name: name.into(), login: login.map(String::from), avatar_url: None }
    }

    fn label(id: &str, name: &str) -> crate::issue_ops::LabelOption {
        crate::issue_ops::LabelOption { id: id.into(), name: name.into(), color: String::new(), description: None, group: None, group_id: None, is_group: false }
    }

    fn state(id: &str, name: &str, position: f64) -> WorkflowState {
        WorkflowState { id: id.into(), name: name.into(), state_type: "started".into(), color: String::new(), position }
    }

    fn linear() -> Fake {
        Fake {
            provider: Provider::Linear,
            issue: issue("linear", "uuid-42", "PRO-42", &["Bug"]),
            options: IssueOptions {
                provider: Provider::Linear,
                states: vec![state("s-done", "Done", 3.0), state("s-todo", "Todo", 1.0), state("s-review", "In Review", 2.0)],
                close_reasons: vec![],
                members: vec![user("u-ada", "Ada Lovelace", None), user("u-alan", "Alan Turing", None)],
                labels: vec![label("l-bug", "Bug"), label("l-ci", "CI"), crate::issue_ops::LabelOption { is_group: true, ..label("l-area", "Area") }],
                priorities: crate::issue_ops::linear_priorities(),
                capabilities: crate::issue_ops::IssueCapabilities::of(Provider::Linear),
            },
            teams: vec![IssueTeam { id: "t-pro".into(), key: "PRO".into(), name: "Product".into() }, IssueTeam { id: "t-ops".into(), key: "OPS".into(), name: "Operations".into() }],
            writes: RefCell::new(Vec::new()),
            fail_with: None,
        }
    }

    fn github() -> Fake {
        Fake {
            provider: Provider::Github,
            issue: issue("github", "12", "#12", &["bug", "triage"]),
            options: IssueOptions {
                provider: Provider::Github,
                states: vec![],
                close_reasons: vec![CloseReason::Completed, CloseReason::NotPlanned],
                members: vec![user("octocat", "The Octocat", Some("octocat")), user("hubot", "Hubot", Some("hubot"))],
                labels: vec![label("bug", "bug"), label("triage", "triage"), label("good first issue", "good first issue")],
                priorities: vec![],
                capabilities: crate::issue_ops::IssueCapabilities::of(Provider::Github),
            },
            teams: vec![],
            writes: RefCell::new(Vec::new()),
            fail_with: None,
        }
    }

    impl Fake {
        fn wrote(&self, write: Value) -> OpResult<IssueDetails> {
            if let Some(kind) = self.fail_with {
                return Err(IssueOpError::new(kind, self.provider));
            }
            self.writes.borrow_mut().push(write);
            Ok(self.issue.clone())
        }
        fn writes(&self) -> Vec<Value> {
            self.writes.borrow().clone()
        }
    }

    impl Backend for Fake {
        fn provider(&self) -> Provider {
            self.provider
        }
        fn details(&self, id: &str) -> OpResult<IssueDetails> {
            assert!(id == self.issue.issue.id || id == self.issue.issue.identifier.trim_start_matches('#') || id == self.issue.issue.identifier, "{id}");
            Ok(self.issue.clone())
        }
        fn comments(&self, id: &str) -> OpResult<Vec<IssueComment>> {
            assert_eq!(id, self.issue.issue.id, "comments are read by the provider's own id");
            Ok(vec![IssueComment { id: "c1".into(), author: Some(user("u-ada", "Ada Lovelace", None)), body: "Still broken.".into(), created_at: "2026-10-02T00:00:00Z".into(), edited_at: None, url: None, viewer_can_edit: false, viewer_can_delete: false }])
        }
        fn options(&self, _id: Option<&str>, _team_id: Option<&str>) -> OpResult<IssueOptions> {
            Ok(self.options.clone())
        }
        fn comment_add(&self, id: &str, body: &str) -> OpResult<IssueComment> {
            self.wrote(json!({"comment": body, "id": id}))?;
            Ok(IssueComment { id: "c2".into(), author: None, body: body.into(), created_at: "now".into(), edited_at: None, url: None, viewer_can_edit: true, viewer_can_delete: true })
        }
        fn set_state(&self, id: &str, change: &StateChange) -> OpResult<IssueDetails> {
            self.wrote(json!({"state": change, "id": id}))
        }
        fn set_assignees(&self, id: &str, assignees: &[String]) -> OpResult<IssueDetails> {
            self.wrote(json!({"assignees": assignees, "id": id}))
        }
        fn set_labels(&self, id: &str, labels: &[String]) -> OpResult<IssueDetails> {
            self.wrote(json!({"labels": labels, "id": id}))
        }
        fn create(&self, input: &IssueCreate) -> OpResult<IssueDetails> {
            self.wrote(json!({"create": input}))
        }
        fn viewer(&self) -> OpResult<String> {
            Ok(if self.provider == Provider::Linear { "u-me".into() } else { "me-login".into() })
        }
        fn teams(&self) -> OpResult<Vec<IssueTeam>> {
            Ok(self.teams.clone())
        }
        fn place(&self) -> String {
            "acme/api".into()
        }
    }

    /// The gate as the control service builds it, for a project of
    /// `acme/api` whose switch is `allows`.
    fn run_as_agent(fake: &Fake, command: &str, params: Value, id: Option<&str>, answer: fn() -> Answer, allows: bool) -> (Result<Value, ControlError>, Vec<Question>) {
        let (ask, asked) = asking(answer);
        let gate = |write: &Write, issue: &str, repo: Option<&str>| {
            let subject = Subject { issue, provider: if fake.provider == Provider::Linear { "linear" } else { "github" }, project_name: "raccoon", routine_allowed: allows && in_project(repo, Some("acme/api")), session_id: Some("session-1"), session_title: Some("Fix login") };
            authorize(write, &subject, Some(&ask))
        };
        let result = run(command, &params, id, fake, &gate);
        let asked = asked.lock().unwrap().clone();
        (result, asked)
    }

    #[test]
    fn viewing_reads_the_issue_and_its_comments_and_asks_nobody() {
        let fake = linear();
        let (answer, asked) = run_as_agent(&fake, "view", json!({}), Some("PRO-42"), || Answer::Declined, false);
        let answer = answer.unwrap();
        assert_eq!(answer["issue"]["identifier"], "PRO-42");
        assert_eq!(answer["issue"]["description"], "It fails.");
        assert!(answer.get("comments").is_none());
        let (answer, _) = run_as_agent(&fake, "view", json!({"comments": true}), Some("PRO-42"), || Answer::Declined, false);
        // The app's own types, as the Tauri commands answer them.
        let comments: Vec<IssueComment> = serde_json::from_value(answer.unwrap()["comments"].clone()).unwrap();
        assert_eq!(comments[0].body, "Still broken.");
        assert!(asked.is_empty() && fake.writes().is_empty());
    }

    #[test]
    fn an_agents_comment_is_posted_only_once_the_person_agrees() {
        let fake = github();
        let (refused, asked) = run_as_agent(&fake, "comment", json!({"body": "PR: #13"}), Some("12"), || Answer::Declined, false);
        assert_eq!(refused.unwrap_err().code, "declined");
        assert!(fake.writes().is_empty(), "a refusal changes nothing");
        assert_eq!(asked.len(), 1);
        assert!(asked[0].message.contains("post this comment on #12 (\u{201c}Fix the login\u{201d}):\n\n\u{2503} PR: #13"), "{}", asked[0].message);
        assert_eq!(asked[0].title, "GitHub issue request");

        let (posted, _) = run_as_agent(&fake, "comment", json!({"body": "PR: #13"}), Some("12"), || Answer::Accepted, false);
        let comment: IssueComment = serde_json::from_value(posted.unwrap()["comment"].clone()).unwrap();
        assert_eq!(comment.body, "PR: #13");
        assert_eq!(fake.writes(), vec![json!({"comment": "PR: #13", "id": "12"})]);

        // A project that allows it: no question.
        let (_, asked) = run_as_agent(&fake, "comment", json!({"body": "again"}), Some("12"), || Answer::Declined, true);
        assert!(asked.is_empty());
        assert_eq!(fake.writes().len(), 2);
    }

    #[test]
    fn the_switch_follows_the_issue_and_not_the_project_an_agent_names() {
        // A project that allows it, and an issue of another repository: asked.
        let mut elsewhere = github();
        elsewhere.issue.issue.url = "https://github.com/acme/other/issues/12".into();
        let (refused, asked) = run_as_agent(&elsewhere, "comment", json!({"body": "hi"}), Some("12"), || Answer::Declined, true);
        assert_eq!((refused.unwrap_err().code.as_str(), asked.len()), ("declined", 1));
        assert!(elsewhere.writes().is_empty());
        // Transferred: asked in acme/api, now in another repository. The
        // repository it was asked in is not what decides.
        let mut moved = github();
        moved.issue.issue.url = "https://github.com/acme/elsewhere/issues/3".into();
        assert_eq!(moved.issue.repo.as_deref(), Some("acme/api"));
        let (refused, asked) = run_as_agent(&moved, "status", json!({"to": "closed"}), Some("12"), || Answer::Declined, true);
        assert_eq!((refused.unwrap_err().code.as_str(), asked.len()), ("declined", 1));
        assert!(moved.writes().is_empty());
        // Linear: the key reaches every team, so the switch never applies.
        let linear = linear();
        let (refused, asked) = run_as_agent(&linear, "status", json!({"to": "Done"}), Some("PRO-42"), || Answer::Declined, true);
        assert_eq!((refused.unwrap_err().code.as_str(), asked.len()), ("declined", 1));
        assert!(linear.writes().is_empty());
        // Its own repository's issue: not asked.
        let own = github();
        let (posted, asked) = run_as_agent(&own, "status", json!({"to": "closed"}), Some("12"), || Answer::Declined, true);
        posted.unwrap();
        assert!(asked.is_empty());
    }

    #[test]
    fn a_linear_status_move_names_one_of_the_teams_states() {
        let fake = linear();
        let (moved, asked) = run_as_agent(&fake, "status", json!({"to": "in review"}), Some("PRO-42"), || Answer::Accepted, false);
        moved.unwrap();
        assert!(asked[0].message.contains("move PRO-42 (\u{201c}Fix the login\u{201d}) to \u{201c}In Review\u{201d}."), "{}", asked[0].message);
        assert_eq!(fake.writes(), vec![json!({"state": {"kind": "workflow_state", "stateId": "s-review"}, "id": "uuid-42"})]);

        // Unknown: refused before anyone is asked, listing the states in the team's order.
        let (unknown, asked) = run_as_agent(&fake, "status", json!({"to": "Review"}), Some("PRO-42"), || Answer::Accepted, false);
        let unknown = unknown.unwrap_err();
        assert_eq!(unknown.code, "invalid_arguments");
        assert!(unknown.message.contains("The states are \u{201c}Todo\u{201d}, \u{201c}In Review\u{201d}, \u{201c}Done\u{201d}."), "{}", unknown.message);
        assert!(asked.is_empty());

        let mut twice = linear();
        twice.options.states.push(state("s-done-2", "DONE", 4.0));
        let (ambiguous, asked) = run_as_agent(&twice, "status", json!({"to": "done"}), Some("PRO-42"), || Answer::Accepted, false);
        assert_eq!(ambiguous.unwrap_err().code, "ambiguous_selector");
        assert!(asked.is_empty() && twice.writes().is_empty());
        assert_eq!(fake.writes().len(), 1);
    }

    #[test]
    fn a_github_issue_closes_with_a_reason_or_reopens() {
        let fake = github();
        let (_, asked) = run_as_agent(&fake, "status", json!({"to": "Closed", "reason": "not_planned"}), Some("12"), || Answer::Accepted, false);
        assert!(asked[0].message.contains("to \u{201c}closed as not planned\u{201d}"), "{}", asked[0].message);
        run_as_agent(&fake, "status", json!({"to": "closed"}), Some("12"), || Answer::Accepted, false).0.unwrap();
        run_as_agent(&fake, "status", json!({"to": "open"}), Some("12"), || Answer::Accepted, false).0.unwrap();
        assert_eq!(fake.writes(), vec![
            json!({"state": {"kind": "close", "reason": "not_planned"}, "id": "12"}),
            json!({"state": {"kind": "close", "reason": "completed"}, "id": "12"}),
            json!({"state": {"kind": "reopen"}, "id": "12"}),
        ]);
        let wrong = run_as_agent(&fake, "status", json!({"to": "done"}), Some("12"), || Answer::Accepted, false).0.unwrap_err();
        assert!(wrong.message.contains("The states are \u{201c}open\u{201d}, \u{201c}closed\u{201d}."), "{}", wrong.message);
        assert!(run_as_agent(&fake, "status", json!({"to": "open", "reason": "completed"}), Some("12"), || Answer::Accepted, false).0.is_err());
        assert_eq!(fake.writes().len(), 3);
    }

    #[test]
    fn assignees_are_named_people_the_viewer_or_nobody() {
        let fake = linear();
        let (_, asked) = run_as_agent(&fake, "assign", json!({"to": ["ada lovelace"], "me": false, "none": false}), Some("PRO-42"), || Answer::Accepted, false);
        assert!(asked[0].message.contains("assign PRO-42 (\u{201c}Fix the login\u{201d}) to \u{201c}Ada Lovelace\u{201d}."), "{}", asked[0].message);
        run_as_agent(&fake, "assign", json!({"to": [], "me": true, "none": false}), Some("PRO-42"), || Answer::Accepted, false).0.unwrap();
        run_as_agent(&fake, "assign", json!({"to": [], "me": false, "none": true}), Some("PRO-42"), || Answer::Accepted, false).0.unwrap();
        assert_eq!(fake.writes(), vec![json!({"assignees": ["u-ada"], "id": "uuid-42"}), json!({"assignees": ["u-me"], "id": "uuid-42"}), json!({"assignees": [], "id": "uuid-42"})]);
        let unknown = run_as_agent(&fake, "assign", json!({"to": ["Grace"]}), Some("PRO-42"), || Answer::Accepted, false).0.unwrap_err();
        assert!(unknown.message.contains("No person is named \u{201c}Grace\u{201d}") && unknown.message.contains("\u{201c}Ada Lovelace\u{201d}"), "{}", unknown.message);

        let fake = github();
        run_as_agent(&fake, "assign", json!({"to": ["@octocat", "HUBOT"]}), Some("12"), || Answer::Accepted, false).0.unwrap();
        assert_eq!(fake.writes(), vec![json!({"assignees": ["octocat", "hubot"], "id": "12"})]);
        // Even with the switch on, assigning asks.
        let (refused, asked) = run_as_agent(&fake, "assign", json!({"me": true}), Some("12"), || Answer::Declined, true);
        assert_eq!((refused.unwrap_err().code.as_str(), asked.len()), ("declined", 1));
        assert_eq!(fake.writes().len(), 1);
    }

    #[test]
    fn labels_are_added_and_removed_on_top_of_what_the_issue_has() {
        let fake = github();
        let (_, asked) = run_as_agent(&fake, "label", json!({"add": ["Good First Issue"], "remove": ["TRIAGE"]}), Some("12"), || Answer::Accepted, false);
        assert!(asked[0].message.contains("add \u{201c}good first issue\u{201d} and remove \u{201c}triage\u{201d}"), "{}", asked[0].message);
        assert_eq!(fake.writes(), vec![json!({"labels": ["bug", "good first issue"], "id": "12"})]);
        // Already there, and not there: nothing to do, so nobody is asked.
        let (same, asked) = run_as_agent(&fake, "label", json!({"add": ["bug"], "remove": ["wontfix"]}), Some("12"), || Answer::Declined, false);
        assert_eq!(same.unwrap()["issue"]["identifier"], "#12");
        assert!(asked.is_empty() && fake.writes().len() == 1);
        let unknown = run_as_agent(&fake, "label", json!({"add": ["urgent"]}), Some("12"), || Answer::Accepted, false).0.unwrap_err();
        assert!(unknown.message.contains("No label is named \u{201c}urgent\u{201d}"), "{}", unknown.message);

        let mut accented = github();
        accented.options.labels.push(label("Évolution", "Évolution"));
        accented.issue.issue.labels.push(crate::issues::IssueLabel { id: None, name: "Évolution".into(), color: String::new() });
        run_as_agent(&accented, "label", json!({"remove": ["évolution"]}), Some("12"), || Answer::Accepted, false).0.unwrap();
        assert_eq!(accented.writes(), vec![json!({"labels": ["bug", "triage"], "id": "12"})], "case is ignored beyond ASCII");

        let fake = linear();
        run_as_agent(&fake, "label", json!({"add": ["ci"]}), Some("PRO-42"), || Answer::Accepted, false).0.unwrap();
        assert_eq!(fake.writes(), vec![json!({"labels": ["l-bug", "l-ci"], "id": "uuid-42"})]);
        // A label group is not a label an issue can have.
        assert!(run_as_agent(&fake, "label", json!({"add": ["Area"]}), Some("PRO-42"), || Answer::Accepted, false).0.is_err());
    }

    #[test]
    fn a_new_issue_names_its_place_and_maps_its_fields() {
        let fake = linear();
        let params = json!({"title": "Flaky test", "body": "Seen twice.", "team": "pro", "assignees": ["Alan Turing"], "labels": ["ci"], "state": "todo", "priority": 2});
        let (created, asked) = run_as_agent(&fake, "create", params, None, || Answer::Accepted, true);
        created.unwrap();
        assert!(asked[0].message.contains("create the issue \u{201c}Flaky test\u{201d} in the Linear team PRO with this description:\n\n\u{2503} Seen twice."), "{}", asked[0].message);
        assert_eq!(fake.writes(), vec![json!({"create": {"teamId": "t-pro", "title": "Flaky test", "description": "Seen twice.", "assignees": ["u-alan"], "labels": ["l-ci"], "stateId": "s-todo", "priority": 2}})]);
        let no_team = run_as_agent(&fake, "create", json!({"title": "t"}), None, || Answer::Accepted, false).0.unwrap_err();
        assert!(no_team.message.contains("pass --team with one of PRO, OPS"), "{}", no_team.message);

        let fake = github();
        let (_, asked) = run_as_agent(&fake, "create", json!({"title": "Crash", "labels": ["bug"]}), None, || Answer::Accepted, false);
        assert!(asked[0].message.contains("create the issue \u{201c}Crash\u{201d} in acme/api."), "{}", asked[0].message);
        assert_eq!(fake.writes(), vec![json!({"create": {"title": "Crash", "description": "", "assignees": [], "labels": ["bug"]}})]);
        assert!(run_as_agent(&fake, "create", json!({"title": "t", "priority": 1}), None, || Answer::Accepted, false).0.unwrap_err().message.contains("for Linear"));
        let (refused, _) = run_as_agent(&fake, "create", json!({"title": "t"}), None, || Answer::Expired, false);
        assert_eq!(refused.unwrap_err().code, "expired");
        assert_eq!(fake.writes().len(), 1);
    }

    #[test]
    fn a_provider_failure_keeps_its_kind_and_its_fixed_message() {
        let mut fake = github();
        fake.fail_with = Some(IssueOpErrorKind::MissingScope);
        let error = run_as_agent(&fake, "comment", json!({"body": "hi"}), Some("12"), || Answer::Accepted, false).0.unwrap_err();
        assert_eq!(error.code, "missing_scope");
        assert_eq!(error.message, crate::issue_ops::message(IssueOpErrorKind::MissingScope, Provider::Github));
        assert_eq!(op_error(IssueOpError::new(IssueOpErrorKind::RateLimited, Provider::Linear)).code, "rate_limited");
        assert_eq!(op_error(IssueOpError::new(IssueOpErrorKind::NotImplemented, Provider::Linear)).code, "not_implemented");
    }

    /// Live, opt-in (`TERMINALX_LIVE_ISSUE_SANDBOX=1 cargo test -- --ignored live_sandbox`):
    /// the real `gh` login and Linear key, and only the two sandbox issues the
    /// owner set aside, with the person who runs it as the one who agrees.
    #[test]
    #[ignore]
    fn live_sandbox() {
        if std::env::var("TERMINALX_LIVE_ISSUE_SANDBOX").as_deref() != Ok("1") {
            return;
        }
        // The person running this check is the one who agrees.
        let (ask, _) = asking(|| Answer::Accepted);
        let gate = |write: &Write, issue: &str, _: Option<&str>| authorize(write, &Subject { issue, provider: "", project_name: "", routine_allowed: false, session_title: None, session_id: None }, Some(&ask));
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        for (provider, id) in [(Provider::Github, "527"), (Provider::Linear, "PRO-101")] {
            let backend = Live(crate::issue_ops::Target::resolve(&repo, provider).unwrap());
            let viewed = run("view", &json!({}), Some(id), &backend, &gate).unwrap();
            println!("{provider:?} view: {} {:?} state={} assignees={}", viewed["issue"]["identifier"], viewed["issue"]["title"].as_str().unwrap_or_default(), viewed["issue"]["state"], viewed["issue"]["assignees"].as_array().map_or(0, Vec::len));
            assert!(viewed["issue"]["title"].as_str().unwrap().starts_with("[TerminalX test]"), "only the sandbox issue");
            for (command, params) in [("view", json!({"comments": true})), ("comment", json!({"body": "[TerminalX test] CLI live check"})), ("status", json!({"to": "Backlog"}))] {
                match run(command, &params, Some(id), &backend, &gate) {
                    Ok(answer) => {
                        println!("{provider:?} {command}: ok {}", answer.as_object().map(|map| map.keys().cloned().collect::<Vec<_>>().join(",")).unwrap_or_default());
                        // The sandbox keeps no test comment.
                        if let Some(comment) = answer["comment"]["id"].as_str() {
                            let issue = viewed["issue"]["id"].as_str().unwrap();
                            println!("{provider:?} cleanup: {:?}", crate::issue_ops::comment_delete(&backend.0, issue, comment).map_err(|error| error.kind));
                        }
                    }
                    Err(error) => println!("{provider:?} {command}: {} — {}", error.code, error.message),
                }
            }
        }
    }

}
