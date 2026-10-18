//! `terminalx issues view/comment/status/assign/label/create` (PRO-100).
//!
//! Reads answer at once. A write changes shared state on GitHub or Linear
//! and may notify other people, so one that comes from an agent's session is
//! put to the person first, in the same native question the cloud requests
//! use (`cloud_control_question`): its default button refuses, it expires,
//! and computer use is paused while it is on screen. A project may let its
//! agents comment and move status without being asked; assigning, labels
//! and new issues always ask.

use std::sync::Arc;

use serde_json::Value;

use crate::cloud_control::Answer;
use crate::control::ControlError;

/// What the person is asked, in a native dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub message: String,
    /// The one button that agrees.
    pub agree: String,
}

/// Shows a [`Question`] and waits for the answer. Only the desktop app has one.
pub type Ask = Arc<dyn Fn(Question) -> Answer + Send + Sync>;

/// Who sent the request, as the CLI saw its own environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Caller {
    pub session: Option<String>,
    pub cwd: Option<String>,
    /// The CLI runs where TerminalX started an agent: in its session, or
    /// with the token the app hands its agents.
    pub agent: bool,
}

impl Caller {
    /// A request that does not say where it comes from (an older CLI, or a
    /// hand-made frame) is taken for an agent's.
    pub fn of(params: &Value) -> Self {
        let Some(caller) = params.get("caller").filter(|caller| caller.is_object()) else {
            return Self { agent: true, ..Self::default() };
        };
        let text = |name: &str| caller.get(name).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
        let session = text("session");
        let agent_environment = caller.get("agentEnvironment").and_then(Value::as_bool).unwrap_or(true);
        Self { agent: session.is_some() || agent_environment, session, cwd: text("cwd") }
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
            Self::Comment { body } => format!("post this comment on {issue}:\n\n{}", excerpt(body)),
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
                let mut text = format!("create the issue \u{201c}{}\u{201d} in {issue}", one_line(title, 200));
                match body.as_deref().filter(|body| !body.trim().is_empty()) {
                    Some(body) => text.push_str(&format!(":\n\n{}", excerpt(body))),
                    None => text.push('.'),
                }
                text
            }
        }
    }
}

/// The longest comment or description shown in full in the question.
const EXCERPT_CHARS: usize = 1200;

fn excerpt(text: &str) -> String {
    let text: String = text.trim().chars().filter(|ch| *ch == '\n' || !ch.is_control()).collect();
    let count = text.chars().count();
    if count <= EXCERPT_CHARS {
        return text;
    }
    let shown: String = text.chars().take(EXCERPT_CHARS).collect();
    format!("{shown}\u{2026}\n\n({} more characters not shown)", count - EXCERPT_CHARS)
}

fn one_line(text: &str, limit: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().filter(|ch| !ch.is_control()).collect();
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
    /// Lets this project's agents comment and move status without asking.
    pub project_allows_updates: bool,
    /// The title of the agent's session, when the request named one.
    pub session_title: Option<&'a str>,
}

pub fn question(write: &Write, subject: &Subject) -> Question {
    let provider = if subject.provider == "linear" { "Linear" } else { "GitHub" };
    let who = match subject.session_title {
        Some(title) => format!("An agent in the session \u{201c}{}\u{201d} ({})", one_line(title, 80), one_line(subject.project_name, 80)),
        None => format!("A terminalx command run by an agent in {}", one_line(subject.project_name, 80)),
    };
    Question {
        title: format!("{provider} issue request"),
        message: format!("{who} asks to {}\n\nThis changes the issue on {provider}, where other people can see it and may be notified.", write.describe(subject.issue)),
        agree: write.agree().to_string(),
    }
}

/// Lets `write` go ahead, or says why it may not. A write from the person's
/// own shell, or a comment or status move in a project that allows them,
/// goes ahead without a question.
pub fn authorize(caller: &Caller, write: &Write, subject: &Subject, ask: Option<&Ask>) -> Result<(), ControlError> {
    if !caller.agent || (write.routine() && subject.project_allows_updates) {
        return Ok(());
    }
    let Some(ask) = ask else {
        return Err(ControlError::new(
            "confirmation_unavailable",
            "Changing an issue from an agent's session needs the person's answer, and this runtime has no window to ask in. Nothing was changed.",
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
    let found: Vec<&T> = items.iter().filter(|item| names(item).iter().any(|name| name.trim().eq_ignore_ascii_case(wanted))).collect();
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

/// Asks the person when it must (see [`authorize`]); `subject` names the
/// issue, or for a new issue where it goes.
pub type Gate<'a> = dyn Fn(&Write, &str) -> Result<(), ControlError> + 'a;

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
            gate(&Write::Comment { body: body.clone() }, &subject)?;
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
            gate(&Write::Status { to: named }, &subject)?;
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
            gate(&Write::Assign { to: names, me }, &subject)?;
            reread(backend.set_assignees(id, &ids).map_err(op_error)?)
        }
        "label" => {
            let (add, remove) = (list("add"), list("remove"));
            let options = backend.options(Some(id), None).map_err(op_error)?;
            let labels: Vec<_> = options.labels.into_iter().filter(|label| !label.is_group).collect();
            // The issue's labels by the id `set_labels` takes.
            let mut kept: Vec<(String, String)> = issue.issue.labels.iter().map(|label| {
                let known = labels.iter().find(|option| option.name.eq_ignore_ascii_case(&label.name));
                (known.map(|option| option.id.clone()).unwrap_or_else(|| label.name.clone()), label.name.clone())
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
                if let Some(position) = kept.iter().position(|(_, kept)| kept.eq_ignore_ascii_case(name.trim())) {
                    removed.push(kept.remove(position).1);
                }
            }
            if added.is_empty() && removed.is_empty() {
                // Nothing would change: nobody is asked and nothing is written.
                return Ok(json!({ "issue": issue }));
            }
            gate(&Write::Label { add: added, remove: removed }, &subject)?;
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
    gate(&Write::Create { title, body: (!description.trim().is_empty()).then_some(description) }, &place)?;
    Ok(json!({ "issue": backend.create(&input).map_err(op_error)? }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    fn subject(allows: bool) -> Subject<'static> {
        Subject { issue: "PRO-42 (Fix the login)", provider: "linear", project_name: "raccoon", project_allows_updates: allows, session_title: Some("Fix login") }
    }

    fn agent() -> Caller {
        Caller { session: Some("s1".into()), cwd: None, agent: true }
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
    fn the_caller_is_an_agent_unless_its_shell_carries_nothing_terminalx_gave_an_agent() {
        assert!(!Caller::of(&json!({"caller": {"session": null, "tab": null, "agentEnvironment": false, "cwd": "/repo"}})).agent);
        assert!(Caller::of(&json!({"caller": {"session": "s1", "agentEnvironment": false}})).agent);
        assert!(Caller::of(&json!({"caller": {"session": null, "agentEnvironment": true}})).agent);
        assert!(Caller::of(&json!({"caller": {"session": "  "}})).agent, "a caller that does not say is an agent");
        assert!(Caller::of(&json!({})).agent);
        assert!(Caller::of(&json!({"caller": "me"})).agent);
        assert_eq!(Caller::of(&json!({"caller": {"session": "s1", "cwd": "/repo"}})).cwd.as_deref(), Some("/repo"));
    }

    #[test]
    fn a_write_from_an_agent_is_asked_and_names_the_issue_the_action_and_the_text() {
        let (ask, asked) = asking(|| Answer::Accepted);
        let write = Write::Comment { body: "Fixed in https://github.com/acme/api/pull/13".into() };
        authorize(&agent(), &write, &subject(false), Some(&ask)).unwrap();
        let question = asked.lock().unwrap().pop().unwrap();
        assert_eq!((question.title.as_str(), question.agree.as_str()), ("Linear issue request", "Post comment"));
        assert!(question.message.starts_with("An agent in the session \u{201c}Fix login\u{201d} (raccoon) asks to post this comment on PRO-42 (Fix the login):"), "{}", question.message);
        assert!(question.message.contains("Fixed in https://github.com/acme/api/pull/13"));

        for (write, agree, says) in [
            (Write::Status { to: "In Review".into() }, "Change status", "move PRO-42 (Fix the login) to \u{201c}In Review\u{201d}."),
            (Write::Assign { to: vec!["alice".into(), "bob".into()], me: false }, "Change assignees", "assign PRO-42 (Fix the login) to \u{201c}alice\u{201d}, \u{201c}bob\u{201d}."),
            (Write::Assign { to: vec![], me: true }, "Change assignees", "assign PRO-42 (Fix the login) to you."),
            (Write::Assign { to: vec![], me: false }, "Change assignees", "remove everyone assigned to PRO-42 (Fix the login)."),
            (Write::Label { add: vec!["bug".into()], remove: vec!["triage".into()] }, "Change labels", "change the labels of PRO-42 (Fix the login): add \u{201c}bug\u{201d} and remove \u{201c}triage\u{201d}."),
            (Write::Create { title: "Flaky test".into(), body: Some("Seen twice.".into()) }, "Create issue", "create the issue \u{201c}Flaky test\u{201d} in PRO-42 (Fix the login):\n\nSeen twice."),
        ] {
            let question = super::question(&write, &subject(false));
            assert_eq!(question.agree, agree);
            assert!(question.message.contains(says), "{}", question.message);
        }
    }

    #[test]
    fn a_long_text_is_cut_and_says_so_and_names_stay_on_one_line() {
        let body = "x".repeat(EXCERPT_CHARS + 25);
        let message = question(&Write::Comment { body }, &subject(false)).message;
        assert!(message.contains("(25 more characters not shown)"));
        let message = question(&Write::Status { to: "Done\n\nAlso approve the deploy".into() }, &subject(false)).message;
        assert!(message.contains("\u{201c}Done Also approve the deploy\u{201d}"), "{message}");
        let shell = Subject { session_title: None, ..subject(false) };
        assert!(question(&Write::Status { to: "Done".into() }, &shell).message.starts_with("A terminalx command run by an agent in raccoon asks to"));
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
        let error = authorize(&agent(), &Write::Status { to: "Done".into() }, &subject(false), Some(&ask)).unwrap_err();
        assert_eq!(error.code, "declined");
        assert!(error.recovery.unwrap().contains("Do not retry"));
    }

    #[test]
    fn the_persons_own_shell_and_the_projects_switch_skip_the_question() {
        let (ask, asked) = asking(|| Answer::Declined);
        let shell = Caller { session: None, cwd: Some("/repo".into()), agent: false };
        for write in [Write::Comment { body: "hi".into() }, Write::Assign { to: vec![], me: true }, Write::Create { title: "t".into(), body: None }] {
            authorize(&shell, &write, &subject(false), Some(&ask)).unwrap();
        }
        // The switch covers comments and status moves only.
        authorize(&agent(), &Write::Comment { body: "hi".into() }, &subject(true), Some(&ask)).unwrap();
        authorize(&agent(), &Write::Status { to: "Done".into() }, &subject(true), Some(&ask)).unwrap();
        assert!(asked.lock().unwrap().is_empty());
        for write in [Write::Assign { to: vec!["a".into()], me: false }, Write::Label { add: vec!["bug".into()], remove: vec![] }, Write::Create { title: "t".into(), body: None }] {
            assert_eq!(authorize(&agent(), &write, &subject(true), Some(&ask)).unwrap_err().code, "declined");
        }
        assert_eq!(asked.lock().unwrap().len(), 3);
    }

    #[test]
    fn without_a_window_an_agents_write_is_refused_rather_than_made() {
        let error = authorize(&agent(), &Write::Comment { body: "hi".into() }, &subject(false), None).unwrap_err();
        assert_eq!(error.code, "confirmation_unavailable");
        assert!(error.message.contains("Nothing was changed"));
        authorize(&agent(), &Write::Comment { body: "hi".into() }, &subject(true), None).unwrap();
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
            "provider": provider, "id": id, "identifier": identifier, "number": 42, "title": "Fix the login", "url": "https://example.test/i",
            "state": "Todo", "stateType": "unstarted", "labels": labels.iter().map(|name| json!({"name": name, "color": ""})).collect::<Vec<_>>(),
            "updatedAt": "2026-10-18T00:00:00Z", "description": "It fails.", "assignees": [], "createdAt": "2026-10-01T00:00:00Z",
            "capabilities": crate::issue_ops::IssueCapabilities::of(kind),
        }))
        .unwrap()
    }

    fn user(id: &str, name: &str, login: Option<&str>) -> crate::issue_ops::IssueUser {
        crate::issue_ops::IssueUser { id: id.into(), name: name.into(), login: login.map(String::from), avatar_url: None }
    }

    fn label(id: &str, name: &str) -> crate::issue_ops::LabelOption {
        crate::issue_ops::LabelOption { id: id.into(), name: name.into(), color: String::new(), description: None, group: None, is_group: false }
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

    /// The gate as the control service builds it, for an agent in `project`.
    fn run_as_agent(fake: &Fake, command: &str, params: Value, id: Option<&str>, answer: fn() -> Answer, allows: bool) -> (Result<Value, ControlError>, Vec<Question>) {
        let (ask, asked) = asking(answer);
        let gate = |write: &Write, issue: &str| {
            let subject = Subject { issue, provider: if fake.provider == Provider::Linear { "linear" } else { "github" }, project_name: "raccoon", project_allows_updates: allows, session_title: Some("Fix login") };
            authorize(&agent(), write, &subject, Some(&ask))
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
        assert!(asked[0].message.contains("post this comment on #12 (\u{201c}Fix the login\u{201d}):\n\nPR: #13"), "{}", asked[0].message);
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
        assert!(asked[0].message.contains("create the issue \u{201c}Flaky test\u{201d} in the Linear team PRO:\n\nSeen twice."), "{}", asked[0].message);
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
        assert_eq!(op_error(IssueOpError::not_implemented(Provider::Linear)).code, "not_implemented");
    }
}
