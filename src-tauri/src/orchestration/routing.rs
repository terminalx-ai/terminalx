//! Which model and effort a piece starts on (PRO-275).
//!
//! Every piece has a kind. A table maps each kind to a tier and an effort,
//! with one column per agent, and a tier is resolved against the models the
//! installed agent offers when the plan is stored. The table names tiers, not
//! versions, so it stays right when a vendor ships a new model.
//!
//! The table is built in ([`default_route`]); Settings stores only the rows a
//! person changed ([`Overrides`]), for the app and for each project, so a new
//! built-in default reaches everyone who did not choose otherwise.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::Model;

/// The kinds of work a piece can be. A plan names one for every piece.
pub const KINDS: [&str; 8] = ["search", "logs", "scoped-code", "code", "refactor", "research", "review", "verify"];
/// The agents the table has a column for.
pub const AGENTS: [&str; 2] = ["claude", "codex"];
/// Effort levels, lowest first. A model offers some of them, or none.
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// A model's place in its vendor's line-up. The same four for both agents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Small,
    Mid,
    Large,
    Top,
}

impl Tier {
    pub const ALL: [Tier; 4] = [Tier::Small, Tier::Mid, Tier::Large, Tier::Top];

    pub fn name(self) -> &'static str {
        match self {
            Tier::Small => "small",
            Tier::Mid => "mid",
            Tier::Large => "large",
            Tier::Top => "top",
        }
    }

    /// The model family of this tier on `agent`: Claude Code's alias, or the
    /// family name inside a Codex model id. `None` for an agent the table has
    /// no column for.
    pub fn family(self, agent: &str) -> Option<&'static str> {
        let index = Tier::ALL.iter().position(|tier| *tier == self)?;
        match agent {
            "claude" => Some(["haiku", "sonnet", "opus", "fable"][index]),
            "codex" => Some(["luna", "terra", "sol", "astra"][index]),
            _ => None,
        }
    }

    /// The next tier up; `None` at the top.
    pub fn above(self) -> Option<Tier> {
        let index = Tier::ALL.iter().position(|tier| *tier == self)?;
        Tier::ALL.get(index + 1).copied()
    }
}

/// How an agent reads in a sentence.
pub fn agent_name(agent: &str) -> &str {
    match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        other => other,
    }
}

/// Where a kind of piece starts: a tier, and an effort. No effort means the
/// model's own default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub tier: Tier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

impl Route {
    fn new(tier: Tier, effort: Option<&str>) -> Self {
        Self { tier, effort: effort.map(str::to_owned) }
    }

    /// A route as a settings file or a patch may write it; `None` for a tier
    /// or an effort that does not exist.
    pub fn read(value: &Value) -> Option<Self> {
        let route: Route = serde_json::from_value(value.clone()).ok()?;
        route.effort.as_deref().is_none_or(|effort| EFFORTS.contains(&effort)).then_some(route)
    }
}

/// The built-in table, the same for both agents: cheap models for reading,
/// the middle one for bounded changes and for checking, the large one for
/// everyday engineering, the top one where the thinking is the work.
pub fn default_route(kind: &str) -> Option<Route> {
    Some(match kind {
        "search" | "logs" => Route::new(Tier::Small, None),
        "scoped-code" | "review" | "verify" => Route::new(Tier::Mid, Some("medium")),
        "code" => Route::new(Tier::Large, Some("medium")),
        "refactor" | "research" => Route::new(Tier::Top, Some("medium")),
        _ => return None,
    })
}

/// The rows a person changed, by kind and then by agent. Read leniently: a
/// row for a kind, an agent, a tier or an effort that does not exist is no
/// row, so a damaged file falls back to the default instead of failing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Overrides(pub BTreeMap<String, BTreeMap<String, Route>>);

impl<'de> Deserialize<'de> for Overrides {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let mut rows = BTreeMap::new();
        for (kind, columns) in value.as_object().into_iter().flatten().filter(|(kind, _)| KINDS.contains(&kind.as_str())) {
            let columns: BTreeMap<String, Route> = columns
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(agent, _)| AGENTS.contains(&agent.as_str()))
                .filter_map(|(agent, route)| Some((agent.clone(), Route::read(route)?)))
                .collect();
            if !columns.is_empty() {
                rows.insert(kind.clone(), columns);
            }
        }
        Ok(Self(rows))
    }
}

impl Overrides {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get(&self, kind: &str, agent: &str) -> Option<&Route> {
        self.0.get(kind)?.get(agent)
    }

    /// Set one cell, or with `None` take the override away.
    pub fn set(&mut self, kind: &str, agent: &str, route: Option<Route>) {
        match route {
            Some(route) => {
                self.0.entry(kind.to_string()).or_default().insert(agent.to_string(), route);
            }
            None => {
                if let Some(columns) = self.0.get_mut(kind) {
                    columns.remove(agent);
                    if columns.is_empty() {
                        self.0.remove(kind);
                    }
                }
            }
        }
    }
}

/// The table in force for one project: every kind, every agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Table(pub BTreeMap<String, BTreeMap<String, Route>>);

impl Table {
    /// A project's own row where it has one, else the app's, else the built-in one.
    pub fn resolved(app: &Overrides, project: Option<&Overrides>) -> Self {
        let cell = |kind: &str, agent: &str| project.and_then(|project| project.get(kind, agent)).or_else(|| app.get(kind, agent)).cloned().or_else(|| default_route(kind));
        Self(KINDS.iter().map(|kind| (kind.to_string(), AGENTS.iter().filter_map(|agent| Some((agent.to_string(), cell(kind, agent)?))).collect())).collect())
    }

    pub fn route(&self, kind: &str, agent: &str) -> Option<&Route> {
        self.0.get(kind)?.get(agent)
    }
}

impl Default for Table {
    fn default() -> Self {
        Self::resolved(&Overrides::default(), None)
    }
}

/// The words of a model id: `gpt-6.1-sol` → `gpt`, `6`, `1`, `sol`.
fn words(id: &str) -> impl Iterator<Item = &str> {
    id.split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty())
}

/// The model `agent` offers for `tier`, from the list its CLI gave.
///
/// Claude Code: the family alias (`opus`), which follows the latest release.
/// Codex: the first listed model with the family name in its id; `model/list`
/// puts newer models first, and a model the CLI marks hidden never reaches
/// the list (`harness::codex::models::parse`).
pub fn model_for<'a>(agent: &str, tier: Tier, models: &'a [Model]) -> Option<&'a Model> {
    let family = tier.family(agent)?;
    let mut offered = models.iter().filter(|model| model.harness == agent);
    match agent {
        "claude" => offered.find(|model| model.id == family),
        _ => offered.find(|model| words(&model.id).any(|word| word.eq_ignore_ascii_case(family))),
    }
}

/// The tier a model id belongs to on `agent`: its family name is the alias
/// itself or a word of the id (`claude-opus-5-5`, `gpt-6.1-sol`).
pub fn tier_of(agent: &str, model: &str) -> Option<Tier> {
    Tier::ALL.into_iter().find(|tier| tier.family(agent).is_some_and(|family| words(model).any(|word| word.eq_ignore_ascii_case(family))))
}

/// The entry for a model id on `agent`, when its CLI lists it.
pub fn listed<'a>(agent: &str, model: &str, models: &'a [Model]) -> Option<&'a Model> {
    models.iter().find(|candidate| candidate.harness == agent && candidate.id == model)
}

/// What a piece starts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// Empty for the agent's own default model.
    pub model: String,
    pub effort: Option<String>,
    pub tier: Option<Tier>,
    /// Said in the run when the model is not the table's: the tier has no
    /// installed model.
    pub note: Option<String>,
}

/// Who leads: a tier nobody installed falls back to its model.
pub struct LeadModel<'a> {
    pub agent: &'a str,
    pub model: &'a str,
}

/// The model and effort of a piece of `kind` on `agent`. What the plan names
/// stands; what it leaves out comes from the table.
pub fn choose(kind: &str, agent: &str, plan_model: &str, plan_effort: Option<&str>, table: &Table, models: &[Model], lead: &LeadModel) -> Choice {
    let route = table.route(kind, agent);
    // An effort the model does not offer is not sent to it: the model's own default runs.
    let fits = |effort: Option<&str>, model: &str| effort.filter(|effort| listed(agent, model, models).is_some_and(|model| model.efforts.iter().any(|offered| offered == effort))).map(str::to_owned);
    let table_effort = |model: &str| fits(route.and_then(|route| route.effort.as_deref()), model);
    let effort = |model: &str| plan_effort.map(str::to_owned).or_else(|| table_effort(model));
    if !plan_model.is_empty() {
        return Choice { model: plan_model.to_string(), effort: effort(plan_model), tier: tier_of(agent, plan_model), note: None };
    }
    let Some(route) = route else {
        // An agent the table has no column for runs its own default.
        return Choice { model: String::new(), effort: plan_effort.map(str::to_owned), tier: None, note: None };
    };
    if let Some(model) = model_for(agent, route.tier, models) {
        return Choice { model: model.id.clone(), effort: effort(&model.id), tier: Some(route.tier), note: None };
    }
    let family = route.tier.family(agent).unwrap_or_default();
    let missing = format!("No {} model of {} is installed ({family})", route.tier.name(), agent_name(agent));
    // The lead's model runs on the lead's agent only.
    let (model, runs_on) = match lead.agent == agent && !lead.model.is_empty() {
        true => (lead.model.to_string(), format!("the lead's model, {}", lead.model)),
        false => (String::new(), format!("{}'s default model", agent_name(agent))),
    };
    Choice { effort: effort(&model), tier: tier_of(agent, &model), note: Some(format!("{missing}: this piece runs on {runs_on}.")), model }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    fn model(harness: &str, id: &str, efforts: &[&str], default_effort: Option<&str>) -> Model {
        Model {
            id: id.into(),
            label: id.into(),
            harness: harness.into(),
            efforts: efforts.iter().map(|effort| effort.to_string()).collect(),
            default_effort: default_effort.map(str::to_owned),
            accepts_images: true,
            is_default: false,
            upgrade: None,
            description: None,
            alias: harness == "claude" && !id.contains('-'),
            resolved: None,
        }
    }

    /// What both CLIs list with every tier installed: Claude's aliases and
    /// pinned versions, and Codex's `model/list` as it orders it, newest first.
    pub(crate) fn installed() -> Vec<Model> {
        let full = ["low", "medium", "high", "xhigh", "max"];
        let mut models = crate::models::claude_fallback();
        models.extend(crate::harness::codex::models::parse(&json!({"data": [
            {"id": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol", "supportedReasoningEfforts": full, "defaultReasoningEffort": "low", "isDefault": true},
            {"id": "gpt-6.1-terra", "displayName": "GPT-6.1-Terra", "supportedReasoningEfforts": full, "defaultReasoningEffort": "low"},
            {"id": "gpt-6-astra", "displayName": "GPT-6-Astra", "supportedReasoningEfforts": full, "defaultReasoningEffort": "medium"},
            {"id": "gpt-6-luna", "displayName": "GPT-6-Luna", "supportedReasoningEfforts": ["low", "medium"], "defaultReasoningEffort": "low"},
            {"id": "gpt-5.6-sol", "displayName": "GPT-5.6-Sol", "supportedReasoningEfforts": full, "defaultReasoningEffort": "low"},
        ]})));
        models
    }

    /// The built-in table and every tier installed, for tests that check a plan.
    pub(crate) static TABLE: std::sync::LazyLock<Table> = std::sync::LazyLock::new(Table::default);
    pub(crate) static MODELS: std::sync::LazyLock<Vec<Model>> = std::sync::LazyLock::new(installed);

    const LEAD: LeadModel = LeadModel { agent: "claude", model: "fable" };

    #[test]
    fn the_default_table_routes_each_kind_the_same_for_both_agents() {
        let table = Table::default();
        for (kinds, tier, effort) in [
            (&["search", "logs"][..], Tier::Small, None),
            (&["scoped-code", "review", "verify"], Tier::Mid, Some("medium")),
            (&["code"], Tier::Large, Some("medium")),
            (&["refactor", "research"], Tier::Top, Some("medium")),
        ] {
            for kind in kinds {
                for agent in AGENTS {
                    assert_eq!(table.route(kind, agent), Some(&Route::new(tier, effort)), "{kind} on {agent}");
                }
            }
        }
        // Every kind has a row, and nothing else does.
        assert_eq!(table.0.keys().map(String::as_str).collect::<Vec<_>>().len(), KINDS.len());
        assert_eq!(default_route("essay"), None);
    }

    #[test]
    fn a_claude_piece_resolves_its_tier_by_alias() {
        let models = installed();
        for (tier, alias) in [(Tier::Small, "haiku"), (Tier::Mid, "sonnet"), (Tier::Large, "opus"), (Tier::Top, "fable")] {
            let found = model_for("claude", tier, &models).unwrap();
            // The alias, never the pinned version listed beside it.
            assert_eq!((found.id.as_str(), found.alias), (alias, true));
        }
        let table = Table::default();
        let code = choose("code", "claude", "", None, &table, &models, &LEAD);
        assert_eq!(code, Choice { model: "opus".into(), effort: Some("medium".into()), tier: Some(Tier::Large), note: None });
        // Haiku offers no effort levels: `search` runs on its own default.
        assert_eq!(choose("search", "claude", "", None, &table, &models, &LEAD), Choice { model: "haiku".into(), effort: None, tier: Some(Tier::Small), note: None });
        assert_eq!(choose("research", "claude", "", None, &table, &models, &LEAD).model, "fable");
    }

    #[test]
    fn a_codex_piece_resolves_its_tier_to_the_first_listed_model_of_the_family() {
        let models = installed();
        // Two Sol models are listed; the first, which is the newer, is taken.
        assert_eq!(model_for("codex", Tier::Large, &models).unwrap().id, "gpt-6.1-sol");
        assert_eq!(model_for("codex", Tier::Mid, &models).unwrap().id, "gpt-6.1-terra");
        assert_eq!(model_for("codex", Tier::Small, &models).unwrap().id, "gpt-6-luna");
        assert_eq!(model_for("codex", Tier::Top, &models).unwrap().id, "gpt-6-astra");
        let table = Table::default();
        // Codex ships Terra at low; the table starts it at medium.
        assert_eq!(choose("review", "codex", "", None, &table, &models, &LEAD), Choice { model: "gpt-6.1-terra".into(), effort: Some("medium".into()), tier: Some(Tier::Mid), note: None });
        assert_eq!(choose("logs", "codex", "", None, &table, &models, &LEAD), Choice { model: "gpt-6-luna".into(), effort: None, tier: Some(Tier::Small), note: None });
        // A family name is a word of the id, not a run of letters inside one.
        let lookalike = [model("codex", "gpt-6-solar", &[], None), model("codex", "gpt-6-SOL", &[], None)];
        assert_eq!(model_for("codex", Tier::Large, &lookalike).unwrap().id, "gpt-6-SOL");
    }

    #[test]
    fn a_hidden_codex_model_is_never_chosen() {
        let listed = crate::harness::codex::models::parse(&json!({"data": [
            {"id": "gpt-7-astra-preview", "displayName": "GPT-7-Astra", "hidden": true, "supportedReasoningEfforts": ["medium"]},
            {"id": "gpt-6-astra", "displayName": "GPT-6-Astra", "supportedReasoningEfforts": ["low", "medium", "high"]},
            {"id": "gpt-7-sol", "displayName": "GPT-7-Sol", "hidden": true, "supportedReasoningEfforts": ["medium"]},
        ]}));
        assert_eq!(model_for("codex", Tier::Top, &listed).unwrap().id, "gpt-6-astra");
        // A family whose only model is hidden has none: the piece falls back.
        assert!(model_for("codex", Tier::Large, &listed).is_none());
        let choice = choose("code", "codex", "", None, &Table::default(), &listed, &LeadModel { agent: "codex", model: "gpt-6-astra" });
        assert_eq!(choice.model, "gpt-6-astra");
        assert!(choice.note.is_some());
    }

    #[test]
    fn a_tier_with_no_installed_model_falls_back_to_the_leads_model_and_says_so() {
        // What Codex lists today: no Astra.
        let mut models = crate::models::claude_fallback();
        models.extend(crate::harness::codex::models::fallback());
        let table = Table::default();
        let lead = LeadModel { agent: "codex", model: "gpt-5.6-sol" };
        let choice = choose("refactor", "codex", "", None, &table, &models, &lead);
        assert_eq!((choice.model.as_str(), choice.effort.as_deref(), choice.tier), ("gpt-5.6-sol", Some("medium"), Some(Tier::Large)));
        assert_eq!(choice.note.as_deref(), Some("No top model of Codex is installed (astra): this piece runs on the lead's model, gpt-5.6-sol."));
        // The lead's model runs on the lead's agent only: a Codex worker of a Claude lead takes Codex's default.
        let other = choose("refactor", "codex", "", None, &table, &models, &LEAD);
        assert_eq!((other.model.as_str(), other.effort.as_deref(), other.tier), ("", None, None));
        assert_eq!(other.note.as_deref(), Some("No top model of Codex is installed (astra): this piece runs on Codex's default model."));
        // An installed tier says nothing.
        assert_eq!(choose("code", "codex", "", None, &table, &models, &lead).note, None);
    }

    #[test]
    fn what_a_plan_names_stands_and_what_it_leaves_out_comes_from_the_table() {
        let models = installed();
        let table = Table::default();
        // Both named: the table is not asked.
        assert_eq!(choose("search", "claude", "opus", Some("high"), &table, &models, &LEAD), Choice { model: "opus".into(), effort: Some("high".into()), tier: Some(Tier::Large), note: None });
        // The model named: the kind's effort where that model offers it.
        assert_eq!(choose("code", "claude", "sonnet", None, &table, &models, &LEAD).effort.as_deref(), Some("medium"));
        assert_eq!(choose("code", "claude", "haiku", None, &table, &models, &LEAD).effort, None);
        // The effort named: the kind's model.
        assert_eq!(choose("code", "claude", "", Some("low"), &table, &models, &LEAD), Choice { model: "opus".into(), effort: Some("low".into()), tier: Some(Tier::Large), note: None });
        // A pinned version still knows its tier; a model of no family has none.
        assert_eq!(choose("code", "claude", "claude-sonnet-5-5", None, &table, &models, &LEAD).tier, Some(Tier::Mid));
        assert_eq!(choose("code", "codex", "gpt-5.5", None, &table, &models, &LEAD).tier, None);
    }

    #[test]
    fn a_project_overrides_a_row_and_the_rest_follow_the_app_then_the_default() {
        let app: Overrides = serde_json::from_value(json!({"code": {"claude": {"tier": "mid", "effort": "high"}}, "search": {"codex": {"tier": "mid"}}})).unwrap();
        let project: Overrides = serde_json::from_value(json!({"code": {"claude": {"tier": "top"}}})).unwrap();
        let table = Table::resolved(&app, Some(&project));
        assert_eq!(table.route("code", "claude"), Some(&Route::new(Tier::Top, None)));
        assert_eq!(table.route("code", "codex"), Some(&Route::new(Tier::Large, Some("medium"))));
        assert_eq!(table.route("search", "codex"), Some(&Route::new(Tier::Mid, None)));
        assert_eq!(table.route("search", "claude"), Some(&Route::new(Tier::Small, None)));
        assert_eq!(Table::resolved(&app, None).route("code", "claude"), Some(&Route::new(Tier::Mid, Some("high"))));
        // Stored as written, and read back the same.
        assert_eq!(serde_json::to_value(&app).unwrap(), json!({"code": {"claude": {"tier": "mid", "effort": "high"}}, "search": {"codex": {"tier": "mid"}}}));
        // A damaged row is no row; the rows beside it stand.
        let damaged: Overrides = serde_json::from_value(json!({
            "code": {"claude": {"tier": "huge"}, "codex": {"tier": "mid", "effort": "frantic"}, "gemini": {"tier": "mid"}},
            "essay": {"claude": {"tier": "mid"}}, "logs": {"claude": {"tier": "mid", "effort": "low"}}, "review": 7,
        })).unwrap();
        assert_eq!(serde_json::to_value(&damaged).unwrap(), json!({"logs": {"claude": {"tier": "mid", "effort": "low"}}}));
        // Taking an override away leaves no empty row behind.
        let mut cleared = app.clone();
        cleared.set("code", "claude", None);
        cleared.set("search", "codex", None);
        assert!(cleared.is_empty());
    }

    #[test]
    fn tiers_are_ordered_and_named_per_agent() {
        assert_eq!(Tier::Small.above(), Some(Tier::Mid));
        assert_eq!(Tier::Large.above(), Some(Tier::Top));
        assert_eq!(Tier::Top.above(), None);
        assert_eq!((Tier::Top.family("claude"), Tier::Top.family("codex"), Tier::Top.family("cursor")), (Some("fable"), Some("astra"), None));
        assert_eq!(serde_json::to_value(Tier::Large).unwrap(), json!("large"));
        assert_eq!((tier_of("claude", "opus"), tier_of("codex", "gpt-6.1-terra"), tier_of("codex", "opus")), (Some(Tier::Large), Some(Tier::Mid), None));
    }
}
