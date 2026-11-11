//! The plan a lead writes, and the rules it must pass to become a run.
//!
//! A refusal is a [`PlanError`]: a code for the rule, the piece it names, and
//! a sentence a lead can act on. The first broken rule is reported, in the
//! order the rules are listed in [`validate`].

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::routing::{self, LeadModel, Table, KINDS};
use super::{Brief, Budget, Estimate, Piece, PieceState};
use crate::models::Model;

/// The modes a worker may be started in: the ones `sessions create --mode` takes.
pub const MODES: [&str; 5] = ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"];

/// A plan as `runs create --from` reads it. A key it does not know is refused, not
/// ignored: a mode written as `mode` would otherwise run in the project's default.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub goal: String,
    #[serde(default)]
    pub budget: Budget,
    /// The agent of a piece that names none; the lead's own when absent.
    #[serde(default)]
    pub agent: Option<String>,
    pub pieces: Vec<PlanPiece>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanPiece {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub out_of_scope: String,
    #[serde(default)]
    pub known: Vec<String>,
    #[serde(default)]
    pub read_first: Vec<String>,
    #[serde(default)]
    pub limits: Vec<String>,
    #[serde(default)]
    pub owns: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub done_check: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub reads_untrusted: bool,
    #[serde(default)]
    pub estimate: Option<Estimate>,
}

/// Why a plan was refused. `code` is the rule; `piece` the piece it names.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub piece: Option<String>,
    pub message: String,
    /// The rule's own particulars: the other piece and the path, the cycle, the limit.
    #[serde(skip_serializing_if = "Value::is_null")]
    pub details: Value,
}

impl PlanError {
    fn new(code: &'static str, piece: Option<&str>, message: String, details: Value) -> Self {
        Self { code, piece: piece.map(str::to_owned), message, details }
    }
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The keys a piece may have, as a plan writes them.
const PIECE_KEYS: [&str; 19] = [
    "id", "title", "goal", "why", "scope", "outOfScope", "known", "readFirst", "limits", "owns", "dependsOn", "doneCheck", "kind", "agent", "model", "effort", "permissionMode", "readsUntrusted", "estimate",
];
const PLAN_KEYS: [&str; 4] = ["goal", "budget", "agent", "pieces"];

/// Read a plan from JSON. A key the plan format does not have is refused with the piece
/// it is in and the key it was probably meant to be: silently dropping `"mode": "manual"`
/// would start that piece in the project's mode instead.
pub fn parse(value: &Value) -> Result<Plan, PlanError> {
    let unknown = |keys: &[&str], object: &Value, piece: Option<&str>| -> Result<(), PlanError> {
        let Some(found) = object.as_object().and_then(|object| object.keys().find(|key| !keys.contains(&key.as_str()))) else { return Ok(()) };
        // The same word in another spelling (`depends_on`), or a known key's last word (`mode`).
        let plain = |key: &str| key.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
        let meant = keys.iter().find(|key| plain(key) == plain(found)).or_else(|| keys.iter().find(|key| plain(key).ends_with(&plain(found)) && plain(found).len() >= 4));
        let hint = meant.map(|key| format!(" Did you mean `{key}`?")).unwrap_or_default();
        let place = piece.map(|id| format!("Piece {id}")).unwrap_or_else(|| "The plan".into());
        Err(PlanError::new("unknown_key", piece, format!("{place} has the key `{found}`, which a plan does not have.{hint} Nothing in a plan is ignored, so correct or remove it."), json!({"key": found, "meant": meant})))
    };
    unknown(&PLAN_KEYS, value, None)?;
    for (index, piece) in value["pieces"].as_array().into_iter().flatten().enumerate() {
        let id = piece["id"].as_str().map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned).unwrap_or_else(|| (index + 1).to_string());
        unknown(&PIECE_KEYS, piece, Some(&id))?;
    }
    serde_json::from_value(value.clone()).map_err(|error| PlanError::new("plan_invalid", None, format!("The plan cannot be read: {error}. A plan is a JSON object with `goal` and `pieces`; each piece has `id`, `title` and `doneCheck`."), Value::Null))
}

/// What a plan is checked against: the project's settings and the agents on offer.
pub struct Rules<'a> {
    pub piece_limit: u32,
    /// The agent of a piece whose plan names none.
    pub default_agent: &'a str,
    /// The agents a worker can be: ones that run in their own terminal and so
    /// can be held to a report.
    pub agents: &'a [String],
    /// The mode the project's workers run in.
    pub worker_mode: &'a str,
    /// A person approves the plan before anything starts. Without that, no
    /// piece may ask for a mode that allows more than the project's.
    pub approval: bool,
    /// The project's routing table: the model and effort of a piece whose plan names none.
    pub routing: &'a Table,
    /// What the agents' CLIs list: a tier is resolved against it.
    pub models: &'a [Model],
    /// The lead's own model: a tier nobody installed falls back to it.
    pub lead_model: &'a str,
}

/// How much a mode lets an agent do unasked: plan changes nothing, manual
/// asks every time, acceptEdits edits unasked, auto also runs what it judges
/// safe, bypass asks nothing.
fn allows(mode: &str) -> usize {
    ["plan", "manual", "acceptEdits", "auto", "bypassPermissions"].iter().position(|known| *known == mode).unwrap_or(0)
}

/// Check a plan and turn it into the pieces of a run, every one `queued`.
///
/// Refused, in this order: a plan with no goal or no pieces; more pieces
/// than the limit; a piece without an id or a title, or with an id another
/// piece has; an agent that is not on offer, no kind or one that does not
/// exist, an unknown permission mode, or one that allows more than the
/// project's where nobody approves the plan; a piece with no done-check; a dependency on a piece the plan does not have;
/// a dependency cycle; two pieces that own the same file.
pub fn validate(plan: &Plan, rules: &Rules) -> Result<Vec<Piece>, PlanError> {
    if plan.goal.trim().is_empty() {
        return Err(PlanError::new("plan_invalid", None, "The plan has no goal. Say in `goal` what the run is for.".into(), Value::Null));
    }
    if plan.pieces.is_empty() {
        return Err(PlanError::new("plan_invalid", None, "The plan has no pieces. A run needs at least one.".into(), Value::Null));
    }
    let (count, limit) = (plan.pieces.len(), rules.piece_limit as usize);
    if count > limit {
        return Err(PlanError::new(
            "too_many_pieces",
            None,
            format!("The plan has {count} pieces and the limit is {limit}. Merge pieces, or ask the person to raise the limit in Settings → Orchestrator."),
            json!({"limit": limit, "pieces": count}),
        ));
    }
    let mut seen = HashSet::new();
    for (index, piece) in plan.pieces.iter().enumerate() {
        let id = piece.id.trim();
        if id.is_empty() {
            return Err(PlanError::new("plan_invalid", None, format!("Piece {} has no id.", index + 1), json!({"index": index})));
        }
        if piece.title.trim().is_empty() {
            return Err(PlanError::new("plan_invalid", Some(id), format!("Piece {id} has no title."), Value::Null));
        }
        if !seen.insert(id) {
            return Err(PlanError::new("duplicate_piece", Some(id), format!("Two pieces have the id {id}. Give each piece its own."), Value::Null));
        }
        let agent = piece.agent.as_deref().or(plan.agent.as_deref()).unwrap_or(rules.default_agent);
        if !rules.agents.iter().any(|offered| offered == agent) {
            return Err(PlanError::new(
                "agent_unavailable",
                Some(id),
                format!("Piece {id} names the agent {agent}, which cannot be a worker here. Use one of: {}.", rules.agents.join(", ")),
                json!({"agent": agent, "agents": rules.agents}),
            ));
        }
        // Every piece has a kind: its model and effort come from it, and so does how its result is checked.
        let kind = piece.kind.as_deref().map(str::trim).unwrap_or_default();
        if kind.is_empty() {
            return Err(PlanError::new(
                "no_kind",
                Some(id),
                format!("Piece {id} has no kind. Say in `kind` what sort of work it is, one of: {}. Its model and effort come from its kind unless the plan names them.", KINDS.join(", ")),
                json!({"kinds": KINDS}),
            ));
        }
        if !KINDS.contains(&kind) {
            return Err(PlanError::new("unknown_kind", Some(id), format!("Piece {id} has the kind {kind}, which is not one. Use one of: {}.", KINDS.join(", ")), json!({"kind": kind, "kinds": KINDS})));
        }
        if let Some(mode) = piece.permission_mode.as_deref().filter(|mode| !MODES.contains(mode)) {
            return Err(PlanError::new(
                "invalid_mode",
                Some(id),
                format!("Piece {id} names the permission mode {mode}. Use one of: {}.", MODES.join(", ")),
                json!({"mode": mode}),
            ));
        }
        // A lead does not raise its own workers' permissions: only a person who sees the plan may.
        if let Some(mode) = piece.permission_mode.as_deref().filter(|mode| !rules.approval && allows(mode) > allows(rules.worker_mode)) {
            return Err(PlanError::new(
                "mode_not_allowed",
                Some(id),
                format!("Piece {id} asks for the permission mode {mode}, which allows more than the {} this project's workers run in, and this project starts runs without a person's approval. Use {} or a stricter mode, or ask the person to change the project's setting.", rules.worker_mode, rules.worker_mode),
                json!({"mode": mode, "workerMode": rules.worker_mode}),
            ));
        }
        if let Some(estimate) = piece.estimate.filter(|e| !(e.low.is_finite() && e.high.is_finite() && e.low >= 0.0 && e.high >= e.low)) {
            return Err(PlanError::new(
                "plan_invalid",
                Some(id),
                format!("Piece {id} has an estimate that is not a range of dollars: low {} and high {}.", estimate.low, estimate.high),
                Value::Null,
            ));
        }
    }
    if let Some(piece) = plan.pieces.iter().find(|piece| piece.done_check.trim().is_empty()) {
        let id = piece.id.trim();
        return Err(PlanError::new(
            "no_done_check",
            Some(id),
            format!("Piece {id} has no done-check. Say in `doneCheck` which command or condition proves it is done."),
            Value::Null,
        ));
    }
    for piece in &plan.pieces {
        let id = piece.id.trim();
        if let Some(missing) = piece.depends_on.iter().map(|dependency| dependency.trim()).find(|dependency| !seen.contains(dependency) || *dependency == id) {
            let message = if missing == id { format!("Piece {id} depends on itself.") } else { format!("Piece {id} depends on {missing}, which is not a piece of this plan.") };
            return Err(PlanError::new(if missing == id { "dependency_cycle" } else { "unknown_dependency" }, Some(id), message, json!({"dependsOn": missing, "cycle": [id, id]})));
        }
    }
    if let Some(cycle) = cycle(&plan.pieces) {
        return Err(PlanError::new(
            "dependency_cycle",
            Some(&cycle[0]),
            format!("Piece {} is in a dependency cycle: {}. No piece of a cycle could ever start.", cycle[0], cycle.join(" → ")),
            json!({"cycle": cycle}),
        ));
    }
    for (index, piece) in plan.pieces.iter().enumerate() {
        for earlier in &plan.pieces[..index] {
            if let Some((mine, theirs)) = shared(&piece.owns, &earlier.owns) {
                let (id, other) = (piece.id.trim(), earlier.id.trim());
                let what = if same_path(mine, theirs) { format!("both own {mine}") } else { format!("{mine} and {theirs} cover the same files") };
                return Err(PlanError::new(
                    "shared_file",
                    Some(id),
                    format!("Pieces {id} and {other} {what}. Give each file to one piece, or make one piece depend on the other and own it alone."),
                    json!({"other": other, "path": mine, "otherPath": theirs}),
                ));
            }
        }
    }
    let lead = LeadModel { agent: rules.default_agent, model: rules.lead_model };
    Ok(plan
        .pieces
        .iter()
        .map(|piece| {
            let agent = piece.agent.as_deref().or(plan.agent.as_deref()).unwrap_or(rules.default_agent);
            let kind = piece.kind.as_deref().map(str::trim).unwrap_or_default();
            // What the plan names stands; what it leaves out comes from the table, by kind.
            let chosen = routing::choose(kind, agent, piece.model.trim(), piece.effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty()), rules.routing, rules.models, &lead);
            Piece {
            id: piece.id.trim().to_string(),
            title: piece.title.trim().to_string(),
            brief: Brief {
                // A piece that states no goal of its own is its title.
                goal: if piece.goal.trim().is_empty() { piece.title.trim().to_string() } else { piece.goal.trim().to_string() },
                why: piece.why.trim().to_string(),
                scope: piece.scope.trim().to_string(),
                out_of_scope: piece.out_of_scope.trim().to_string(),
                known: lines(&piece.known),
                read_first: lines(&piece.read_first),
                limits: lines(&piece.limits),
            },
            owns: lines(&piece.owns),
            depends_on: lines(&piece.depends_on),
            done_check: piece.done_check.trim().to_string(),
            kind: piece.kind.as_deref().map(str::trim).filter(|kind| !kind.is_empty()).map(str::to_owned),
            agent: agent.to_string(),
            model: chosen.model,
            effort: chosen.effort,
            tier: chosen.tier,
            model_note: chosen.note,
            permission_mode: piece.permission_mode.clone(),
            reads_untrusted: piece.reads_untrusted,
            estimate: piece.estimate,
            attempts: 0,
            tries: Vec::new(),
            worker: None,
            branch: None,
            held: None,
            started_mode: None,
            state: PieceState::Queued,
            note: None,
            }
        })
        .collect())
}

fn lines(values: &[String]) -> Vec<String> {
    values.iter().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()).collect()
}

/// A dependency cycle, as the ids along it with the first repeated at the
/// end; `None` when the pieces can be put in an order. Every dependency
/// names a piece of the plan by now.
fn cycle(pieces: &[PlanPiece]) -> Option<Vec<String>> {
    #[derive(Clone, Copy, PartialEq)]
    enum Mark { Unseen, Open, Closed }
    let edges: BTreeMap<&str, Vec<&str>> = pieces.iter().map(|piece| (piece.id.trim(), piece.depends_on.iter().map(|id| id.trim()).collect())).collect();
    let mut marks: BTreeMap<&str, Mark> = edges.keys().map(|id| (*id, Mark::Unseen)).collect();
    // Depth first, without recursion: a plan is small, a hand-written one may not be.
    for start in pieces.iter().map(|piece| piece.id.trim()) {
        if marks[start] != Mark::Unseen {
            continue;
        }
        let mut path: Vec<(&str, usize)> = vec![(start, 0)];
        marks.insert(start, Mark::Open);
        while let Some((id, next)) = path.last().copied() {
            match edges[id].get(next) {
                None => {
                    marks.insert(id, Mark::Closed);
                    path.pop();
                }
                Some(dependency) => {
                    path.last_mut().expect("the path is not empty").1 += 1;
                    match marks[dependency] {
                        Mark::Closed => {}
                        Mark::Unseen => {
                            marks.insert(dependency, Mark::Open);
                            path.push((dependency, 0));
                        }
                        Mark::Open => {
                            let from = path.iter().position(|(on_path, _)| on_path == dependency).expect("an open piece is on the path");
                            let mut cycle: Vec<String> = path[from..].iter().map(|(id, _)| id.to_string()).collect();
                            cycle.push(dependency.to_string());
                            return Some(cycle);
                        }
                    }
                }
            }
        }
    }
    None
}

/// The first pair of entries, one from each list, that can name the same file.
fn shared<'a>(mine: &'a [String], theirs: &'a [String]) -> Option<(&'a str, &'a str)> {
    mine.iter().flat_map(|a| theirs.iter().map(move |b| (a.as_str(), b.as_str()))).find(|(a, b)| overlap(a, b)).map(|(a, b)| (a.trim(), b.trim()))
}

fn same_path(a: &str, b: &str) -> bool {
    normal(a) == normal(b)
}

/// A path as two plans would both write it: no `./`, no trailing slash, one
/// slash between parts, and one letter case, since the file systems worktrees
/// usually sit on (APFS, NTFS) hold `Readme.md` and `README.md` as one file.
fn normal(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    path.split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/").to_lowercase()
}

/// Whether two ownership entries can name the same file. An entry names a
/// file, everything under a directory, or the files a glob matches (`*` and
/// `?` within one name, `**` across directories).
pub fn overlap(a: &str, b: &str) -> bool {
    let (a, b) = (normal(a), normal(b));
    if a.is_empty() || b.is_empty() {
        // The repository's root: it holds every file.
        return true;
    }
    let (a, b) = (tokens(&a), tokens(&b));
    let under = |pattern: &[Token]| [pattern, &[Token::Lit('/'), Token::Deep]].concat();
    intersect(&a, &b) || intersect(&under(&a), &b) || intersect(&a, &under(&b))
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Token {
    Lit(char),
    /// `?`: one character of a name.
    One,
    /// `*`: any run of characters within a name.
    Star,
    /// `**`: any run of characters, slashes included.
    Deep,
}

fn tokens(pattern: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(match c {
            '?' => Token::One,
            '*' if chars.peek() == Some(&'*') => {
                while chars.peek() == Some(&'*') {
                    chars.next();
                }
                Token::Deep
            }
            '*' => Token::Star,
            c => Token::Lit(c),
        });
    }
    out
}

/// Whether some path matches both patterns: a walk over pairs of positions,
/// one in each pattern, that both can reach on the same text.
fn intersect(a: &[Token], b: &[Token]) -> bool {
    /// A character both tokens accept, if any: `None` when they share none.
    fn both(x: Token, y: Token) -> bool {
        match (x, y) {
            (Token::Lit(c), Token::Lit(d)) => c == d,
            (Token::Lit(c), Token::One | Token::Star) | (Token::One | Token::Star, Token::Lit(c)) => c != '/',
            _ => true,
        }
    }
    let repeats = |token: Token| matches!(token, Token::Star | Token::Deep);
    let mut seen = HashSet::new();
    let mut open = vec![(0usize, 0usize)];
    while let Some((i, j)) = open.pop() {
        if !seen.insert((i, j)) {
            continue;
        }
        if i == a.len() && j == b.len() {
            return true;
        }
        // A `*` or `**` may match nothing.
        if i < a.len() && repeats(a[i]) {
            open.push((i + 1, j));
        }
        if j < b.len() && repeats(b[j]) {
            open.push((i, j + 1));
        }
        if i < a.len() && j < b.len() && both(a[i], b[j]) {
            // Both take one character; a repeating token may take another after it.
            open.push((if repeats(a[i]) { i } else { i + 1 }, if repeats(b[j]) { j } else { j + 1 }));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::routing::tests::{MODELS, TABLE};
    use crate::orchestration::routing::Tier;

    fn piece(id: &str) -> PlanPiece {
        PlanPiece { id: id.into(), title: format!("Piece {id}"), done_check: "cargo t".into(), kind: Some("code".into()), ..Default::default() }
    }

    fn plan(pieces: Vec<PlanPiece>) -> Plan {
        Plan { goal: "Move settings reads to the typed store".into(), budget: Budget::default(), agent: None, pieces }
    }

    fn check(plan: &Plan, limit: u32) -> Result<Vec<Piece>, PlanError> {
        let agents = ["claude".to_string(), "codex".to_string()];
        validate(plan, &Rules { piece_limit: limit, default_agent: "claude", agents: &agents, worker_mode: "bypassPermissions", approval: true, routing: &TABLE, models: &MODELS, lead_model: "fable" })
    }

    fn refused(plan: &Plan) -> PlanError {
        check(plan, 8).expect_err("the plan is refused")
    }

    #[test]
    fn a_valid_plan_becomes_queued_pieces_with_the_plans_choices() {
        let mut map = piece("map");
        map.kind = Some("search".into());
        let mut store = PlanPiece { goal: "A typed store".into(), owns: vec!["src/store/".into()], depends_on: vec!["map".into()], model: "opus".into(), effort: Some("medium".into()), ..piece("store") };
        store.permission_mode = Some("acceptEdits".into());
        store.reads_untrusted = true;
        store.agent = Some("codex".into());
        let pieces = check(&plan(vec![map, store]), 8).unwrap();
        assert_eq!(pieces.len(), 2);
        assert!(pieces.iter().all(|piece| piece.state == PieceState::Queued && piece.worker.is_none() && piece.attempts == 0));
        // A piece that states no goal is its title; one that names no agent takes the default.
        assert_eq!((pieces[0].brief.goal.as_str(), pieces[0].agent.as_str(), pieces[0].kind.as_deref()), ("Piece map", "claude", Some("search")));
        let store = &pieces[1];
        assert_eq!((store.brief.goal.as_str(), store.agent.as_str(), store.model.as_str(), store.effort.as_deref()), ("A typed store", "codex", "opus", Some("medium")));
        assert_eq!((store.permission_mode.as_deref(), store.reads_untrusted, store.depends_on.as_slice()), (Some("acceptEdits"), true, &["map".to_string()][..]));
        // The plan's own agent is the default of its pieces.
        let mut with_agent = plan(vec![piece("a")]);
        with_agent.agent = Some("codex".into());
        assert_eq!(check(&with_agent, 8).unwrap()[0].agent, "codex");
    }

    #[test]
    fn a_plan_with_kinds_and_no_models_gets_models_and_efforts_from_the_table() {
        let of = |id: &str, kind: &str, agent: &str| PlanPiece { kind: Some(kind.into()), agent: Some(agent.into()), ..piece(id) };
        let pieces = check(&plan(vec![
            of("map", "search", "claude"), of("fix", "scoped-code", "claude"), of("build", "code", "claude"), of("shape", "refactor", "claude"),
            of("logs", "logs", "codex"), of("check", "verify", "codex"), of("port", "code", "codex"), of("study", "research", "codex"),
        ]), 8).unwrap();
        let chosen: Vec<(&str, &str, Option<&str>, Option<Tier>)> = pieces.iter().map(|piece| (piece.id.as_str(), piece.model.as_str(), piece.effort.as_deref(), piece.tier)).collect();
        assert_eq!(chosen, vec![
            ("map", "haiku", None, Some(Tier::Small)),
            ("fix", "sonnet", Some("medium"), Some(Tier::Mid)),
            ("build", "opus", Some("medium"), Some(Tier::Large)),
            ("shape", "fable", Some("medium"), Some(Tier::Top)),
            ("logs", "gpt-6-luna", None, Some(Tier::Small)),
            ("check", "gpt-6.1-terra", Some("medium"), Some(Tier::Mid)),
            ("port", "gpt-6.1-sol", Some("medium"), Some(Tier::Large)),
            ("study", "gpt-6-astra", Some("medium"), Some(Tier::Top)),
        ]);
        assert!(pieces.iter().all(|piece| piece.model_note.is_none() && piece.tries.is_empty()));
        // A plan may override per piece: the model, the effort, or both.
        let named = PlanPiece { model: "sonnet".into(), effort: Some("high".into()), ..of("a", "search", "claude") };
        let effort_only = PlanPiece { effort: Some("low".into()), ..of("b", "code", "claude") };
        let pieces = check(&plan(vec![named, effort_only]), 8).unwrap();
        assert_eq!((pieces[0].model.as_str(), pieces[0].effort.as_deref(), pieces[0].tier), ("sonnet", Some("high"), Some(Tier::Mid)));
        assert_eq!((pieces[1].model.as_str(), pieces[1].effort.as_deref()), ("opus", Some("low")));
        // A worker runs on the lead's agent unless the plan names another, and uses that agent's column.
        let mut on_codex = plan(vec![piece("a")]);
        on_codex.agent = Some("codex".into());
        assert_eq!(check(&on_codex, 8).unwrap()[0].model, "gpt-6.1-sol");
        // The project's table decides, where it differs from the built-in one.
        let project: routing::Overrides = serde_json::from_value(json!({"code": {"claude": {"tier": "mid", "effort": "high"}}})).unwrap();
        let table = Table::resolved(&routing::Overrides::default(), Some(&project));
        let agents = ["claude".to_string(), "codex".to_string()];
        let pieces = validate(&plan(vec![piece("a")]), &Rules { piece_limit: 8, default_agent: "claude", agents: &agents, worker_mode: "bypassPermissions", approval: true, routing: &table, models: &MODELS, lead_model: "fable" }).unwrap();
        assert_eq!((pieces[0].model.as_str(), pieces[0].effort.as_deref()), ("sonnet", Some("high")));
    }

    #[test]
    fn a_tier_nobody_installed_falls_back_to_the_leads_model_and_the_piece_says_so() {
        // What Codex lists today has no Astra.
        let mut models = crate::models::claude_fallback();
        models.extend(crate::harness::codex::models::fallback());
        let agents = ["claude".to_string(), "codex".to_string()];
        let study = PlanPiece { kind: Some("research".into()), ..piece("study") };
        let pieces = validate(&plan(vec![study, piece("build")]), &Rules { piece_limit: 8, default_agent: "codex", agents: &agents, worker_mode: "bypassPermissions", approval: true, routing: &TABLE, models: &models, lead_model: "gpt-5.6-sol" }).unwrap();
        assert_eq!((pieces[0].model.as_str(), pieces[0].effort.as_deref()), ("gpt-5.6-sol", Some("medium")));
        assert_eq!(pieces[0].model_note.as_deref(), Some("No top model of Codex is installed (astra): this piece runs on the lead's model, gpt-5.6-sol."));
        assert_eq!((pieces[1].model.as_str(), pieces[1].model_note.as_deref()), ("gpt-5.6-sol", None));
    }

    #[test]
    fn a_piece_with_no_kind_or_one_that_does_not_exist_is_refused_naming_it() {
        let mut none = piece("b");
        none.kind = None;
        let error = refused(&plan(vec![piece("a"), none]));
        assert_eq!((error.code, error.piece.as_deref()), ("no_kind", Some("b")));
        assert!(error.message.contains("search, logs, scoped-code, code, refactor, research, review, verify"), "{}", error.message);
        let mut blank = piece("b");
        blank.kind = Some("  ".into());
        assert_eq!(refused(&plan(vec![blank])).code, "no_kind");
        let mut other = piece("b");
        other.kind = Some("essay".into());
        let error = refused(&plan(vec![other]));
        assert_eq!((error.code, error.piece.as_deref(), error.details["kind"].as_str()), ("unknown_kind", Some("b"), Some("essay")));
        // Each of the eight is one.
        check(&plan(KINDS.iter().map(|kind| PlanPiece { kind: Some(kind.to_string()), ..piece(kind) }).collect()), 8).unwrap();
    }

    #[test]
    fn two_pieces_that_own_the_same_file_are_refused_naming_both() {
        let own = |id: &str, owns: &[&str]| PlanPiece { owns: owns.iter().map(|path| path.to_string()).collect(), ..piece(id) };
        let error = refused(&plan(vec![own("a", &["src/cli.rs", "docs/"]), own("b", &["src/control.rs"]), own("c", &["./src/cli.rs"])]));
        assert_eq!((error.code, error.piece.as_deref()), ("shared_file", Some("c")));
        assert_eq!(error.details, json!({"other": "a", "path": "./src/cli.rs", "otherPath": "src/cli.rs"}));
        assert!(error.message.contains("Pieces c and a both own ./src/cli.rs"), "{}", error.message);
        // A directory owns what is in it; a glob owns what it matches.
        let error = refused(&plan(vec![own("a", &["src/store"]), own("b", &["src/store/settings/mod.rs"])]));
        assert_eq!((error.code, error.piece.as_deref(), error.details["other"].as_str()), ("shared_file", Some("b"), Some("a")));
        assert!(error.message.contains("src/store/settings/mod.rs and src/store cover the same files"), "{}", error.message);
        assert_eq!(refused(&plan(vec![own("a", &["src/session*.rs"]), own("b", &["src/session_ops.rs"])])).code, "shared_file");
        // Pieces that own different files, or nothing, pass.
        check(&plan(vec![own("a", &["src/session*.rs", "docs/a.md"]), own("b", &["src/cli.rs", "docs/b.md"]), own("c", &[]), own("d", &[])]), 8).unwrap();
    }

    #[test]
    fn ownership_overlaps_by_file_directory_and_glob() {
        for (a, b) in [
            ("src/a.rs", "src/a.rs"),
            ("src/a.rs", "./src//a.rs"),
            ("README.md", "readme.md"),
            ("src", "src/a.rs"),
            ("src/", "src/deep/er/a.rs"),
            ("src/*.rs", "src/a.rs"),
            ("src/a*.rs", "src/*b.rs"),
            ("src/**", "src/x/y.rs"),
            ("**/*.md", "docs/guide/a.md"),
            ("src/*", "src/store/mod.rs"),
            ("docs/?.md", "docs/a.md"),
            (".", "anything/at/all"),
            ("src\\win.rs", "src/win.rs"),
        ] {
            assert!(overlap(a, b), "{a} and {b} share a file");
            assert!(overlap(b, a), "{b} and {a} share a file");
        }
        for (a, b) in [
            ("src/a.rs", "src/b.rs"),
            ("src/a.rs", "src/a.rs.bak"),
            ("src/store", "src/storefront/a.rs"),
            ("src/*.rs", "src/a.ts"),
            ("src/*.rs", "lib/a.rs"),
            ("src/a*.rs", "src/b*.rs"),
            ("docs/?.md", "docs/ab.md"),
            ("src/session*.rs", "src/cli.rs"),
        ] {
            assert!(!overlap(a, b), "{a} and {b} share nothing");
            assert!(!overlap(b, a), "{b} and {a} share nothing");
        }
    }

    #[test]
    fn a_dependency_cycle_is_refused_naming_a_piece_on_it() {
        let after = |id: &str, on: &[&str]| PlanPiece { depends_on: on.iter().map(|id| id.to_string()).collect(), ..piece(id) };
        let error = refused(&plan(vec![after("a", &[]), after("b", &["a", "d"]), after("c", &["b"]), after("d", &["c"])]));
        assert_eq!((error.code, error.piece.as_deref()), ("dependency_cycle", Some("b")));
        assert_eq!(error.details["cycle"], json!(["b", "d", "c", "b"]));
        assert!(error.message.contains("Piece b is in a dependency cycle: b → d → c → b"), "{}", error.message);
        let error = refused(&plan(vec![after("a", &["a"])]));
        assert_eq!((error.code, error.piece.as_deref()), ("dependency_cycle", Some("a")));
        let error = refused(&plan(vec![after("a", &["ghost"])]));
        assert_eq!((error.code, error.piece.as_deref(), error.details["dependsOn"].as_str()), ("unknown_dependency", Some("a"), Some("ghost")));
        // A diamond is not a cycle.
        check(&plan(vec![after("a", &[]), after("b", &["a"]), after("c", &["a"]), after("d", &["b", "c"])]), 8).unwrap();
    }

    #[test]
    fn a_piece_with_no_done_check_is_refused_naming_it() {
        let mut blank = piece("docs");
        blank.done_check = "  ".into();
        let error = refused(&plan(vec![piece("a"), blank]));
        assert_eq!((error.code, error.piece.as_deref()), ("no_done_check", Some("docs")));
        assert!(error.message.contains("Piece docs has no done-check"), "{}", error.message);
    }

    #[test]
    fn a_plan_over_the_piece_limit_is_refused_with_the_limit_named() {
        let nine = plan((1..=9).map(|n| piece(&n.to_string())).collect());
        let error = refused(&nine);
        assert_eq!((error.code, error.piece.as_deref()), ("too_many_pieces", None));
        assert_eq!(error.details, json!({"limit": 8, "pieces": 9}));
        assert!(error.message.contains("9 pieces and the limit is 8"), "{}", error.message);
        // The limit is the setting: raised, the same plan passes; lowered, a smaller one is refused.
        assert_eq!(check(&nine, 9).unwrap().len(), 9);
        let error = check(&plan(vec![piece("a"), piece("b"), piece("c")]), 2).unwrap_err();
        assert_eq!((error.code, &error.details), ("too_many_pieces", &json!({"limit": 2, "pieces": 3})));
    }

    #[test]
    fn a_piece_may_not_raise_its_mode_above_the_projects_unless_a_person_approves_the_plan() {
        let agents = ["claude".to_string()];
        let asking = |mode: &str| {
            let mut piece = piece("a");
            piece.permission_mode = Some(mode.into());
            plan(vec![piece])
        };
        let rules = |worker_mode: &'static str, approval: bool| Rules { piece_limit: 8, default_agent: "claude", agents: &agents, worker_mode, approval, routing: &TABLE, models: &MODELS, lead_model: "fable" };
        // Nobody approves this project's runs: a piece may be stricter than the project, never looser.
        for (project, piece, allowed) in [
            ("manual", "bypassPermissions", false),
            ("manual", "auto", false),
            ("manual", "acceptEdits", false),
            ("manual", "manual", true),
            ("manual", "plan", true),
            ("acceptEdits", "auto", false),
            ("acceptEdits", "manual", true),
            ("bypassPermissions", "bypassPermissions", true),
            ("bypassPermissions", "plan", true),
        ] {
            let checked = validate(&asking(piece), &rules(project, false));
            assert_eq!(checked.is_ok(), allowed, "{piece} in a project whose workers run in {project}");
            if let Err(error) = checked {
                assert_eq!((error.code, error.piece.as_deref()), ("mode_not_allowed", Some("a")));
                assert_eq!(error.details, json!({"mode": piece, "workerMode": project}));
                assert!(error.message.contains(&format!("allows more than the {project}")), "{}", error.message);
            }
        }
        // A person who approves the plan sees the mode of every piece, and may let it stand.
        assert_eq!(validate(&asking("bypassPermissions"), &rules("manual", true)).unwrap()[0].permission_mode.as_deref(), Some("bypassPermissions"));
    }

    #[test]
    fn a_key_a_plan_does_not_have_is_refused_naming_the_piece_and_what_was_meant() {
        let read = |pieces: Value| parse(&json!({"goal": "g", "pieces": pieces}));
        // The mistake that matters most: a mode under another name would run in the project's default.
        for (written, meant) in [("mode", "permissionMode"), ("permission_mode", "permissionMode"), ("depends_on", "dependsOn"), ("done_check", "doneCheck"), ("DoneCheck", "doneCheck"), ("reads_untrusted", "readsUntrusted")] {
            let error = read(json!([{"id": "a", "title": "A", "doneCheck": "x"}, {"id": "b", "title": "B", "doneCheck": "x", written: "manual"}])).unwrap_err();
            assert_eq!((error.code, error.piece.as_deref()), ("unknown_key", Some("b")), "{written}");
            assert_eq!(error.details, json!({"key": written, "meant": meant}));
            assert!(error.message.contains(&format!("Piece b has the key `{written}`")) && error.message.contains(&format!("Did you mean `{meant}`?")), "{}", error.message);
        }
        // A key that resembles none is still refused, and a piece with no id is named by its place.
        let error = read(json!([{"title": "A", "doneCheck": "x", "priority": 1}])).unwrap_err();
        assert_eq!((error.code, error.piece.as_deref(), &error.details), ("unknown_key", Some("1"), &json!({"key": "priority", "meant": null})));
        let error = parse(&json!({"goal": "g", "pieces": [], "approve": true})).unwrap_err();
        assert_eq!((error.code, error.piece.as_deref()), ("unknown_key", None));
        assert!(error.message.starts_with("The plan has the key `approve`"), "{}", error.message);
        // Every key the format has is read, and a plan of the wrong shape says so.
        let whole = parse(&json!({"goal": "g", "budget": {"points": 5}, "agent": "claude", "pieces": [{
            "id": "a", "title": "A", "goal": "g", "why": "w", "scope": "s", "outOfScope": "o", "known": ["k"], "readFirst": ["r"], "limits": ["l"], "owns": ["src/"],
            "dependsOn": [], "doneCheck": "x", "kind": "code", "agent": "codex", "model": "m", "effort": "high", "permissionMode": "manual", "readsUntrusted": true, "estimate": {"low": 1.0, "high": 2.0},
        }]})).unwrap();
        assert_eq!((whole.pieces[0].permission_mode.as_deref(), whole.pieces[0].reads_untrusted, whole.budget.points), (Some("manual"), true, Some(5.0)));
        assert_eq!(parse(&json!({"goal": "g", "pieces": "none"})).unwrap_err().code, "plan_invalid");
        assert_eq!(parse(&json!({"pieces": []})).unwrap_err().code, "plan_invalid");
    }

    #[test]
    fn a_plan_that_is_not_one_is_refused_before_its_pieces_are_read() {
        let mut no_goal = plan(vec![piece("a")]);
        no_goal.goal = " ".into();
        assert_eq!(refused(&no_goal).code, "plan_invalid");
        assert_eq!(refused(&plan(vec![])).code, "plan_invalid");
        assert_eq!(refused(&plan(vec![piece(" ")])).code, "plan_invalid");
        let error = refused(&plan(vec![piece("a"), piece("a")]));
        assert_eq!((error.code, error.piece.as_deref()), ("duplicate_piece", Some("a")));
        let mut untitled = piece("a");
        untitled.title = String::new();
        assert_eq!((refused(&plan(vec![untitled])).code), "plan_invalid");
        let mut agent = piece("a");
        agent.agent = Some("gemini".into());
        let error = refused(&plan(vec![agent]));
        assert_eq!((error.code, error.piece.as_deref()), ("agent_unavailable", Some("a")));
        let mut mode = piece("a");
        mode.permission_mode = Some("yolo".into());
        let error = refused(&plan(vec![mode]));
        assert_eq!((error.code, error.piece.as_deref()), ("invalid_mode", Some("a")));
        let mut estimate = piece("a");
        estimate.estimate = Some(Estimate { low: 2.0, high: 1.0 });
        assert_eq!(refused(&plan(vec![estimate])).code, "plan_invalid");
    }
}
