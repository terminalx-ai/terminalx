//! What a piece tries next when a try falls short (PRO-275).
//!
//! A try falls short when its worker reports `failed` or `partial`, or when
//! the piece's done-check fails. The steps, in order:
//!
//! 1. Try again with the failure text in the brief.
//! 2. Raise the effort one level, never past `high`: one more level can cost
//!    as much as the next model up.
//! 3. Move up one model tier, at one effort level lower.
//! 4. Stop: the piece is `blocked` and goes back to the lead with what was tried.
//!
//! A piece gets at most [`MAX_TRIES`] tries, the first included, so the second
//! try takes steps 1 and 2 together (the failure text, and the effort raised
//! where it can be) and the third takes step 3. Every try after the first is
//! a fresh worker: a model switch loses the prompt cache anyway, and a
//! smaller model cannot read a larger one's reasoning.
//!
//! Nothing here starts anything. [`next`] only says what the next try runs on.

use serde::{Deserialize, Serialize};

use super::routing::{self, Tier, EFFORTS};
use crate::models::Model;

/// The most tries a piece gets, the first included.
pub const MAX_TRIES: usize = 3;
/// Escalation never raises effort past this.
pub const EFFORT_CEILING: &str = "high";

/// What made a try differ from the one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// The first try: the plan's or the table's model and effort.
    First,
    /// The same model and effort again, with the failure text.
    Retry,
    /// The failure text, and the effort raised one level.
    Effort,
    /// One model tier up, at one effort level lower.
    Tier,
    /// A person widened the piece's files after it was blocked and had it
    /// tried again (`engine::widen`): the last try's model and effort.
    Widened,
    /// The lead took the piece over (`engine::take_over`) and finishes it in
    /// its own checkout.
    Lead,
}

/// What the next try runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Next {
    pub step: Step,
    pub model: String,
    pub effort: Option<String>,
    pub tier: Option<Tier>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Again(Next),
    /// No further try, and why, in a sentence.
    Blocked(String),
}

fn level(effort: &str) -> Option<usize> {
    EFFORTS.iter().position(|known| *known == effort)
}

/// The effort a model runs at when a try names `effort`: the one named, else
/// the model's own default. `None` when neither is known.
fn effective(effort: Option<&str>, model: Option<&Model>) -> Option<String> {
    effort.map(str::to_owned).or_else(|| model.and_then(|model| model.default_effort.clone()))
}

/// One level up among the efforts `model` offers, never past the ceiling.
fn raised(effort: Option<&str>, model: Option<&Model>) -> Option<String> {
    let model = model?;
    let now = level(&effective(effort, Some(model))?)?;
    let ceiling = level(EFFORT_CEILING)?;
    model.efforts.iter().filter_map(|offered| Some((level(offered)?, offered))).filter(|(at, _)| *at > now && *at <= ceiling).min_by_key(|(at, _)| *at).map(|(_, offered)| offered.clone())
}

/// One level down from `effort` among the efforts `model` offers. A model
/// with nothing lower runs at `effort` itself when it offers that, else at
/// its own default.
fn lowered(effort: Option<&str>, model: &Model) -> Option<String> {
    let now = level(effort?)?;
    let offered = |wanted: &dyn Fn(usize) -> bool| model.efforts.iter().filter_map(|offered| Some((level(offered)?, offered))).filter(|(at, _)| wanted(*at)).max_by_key(|(at, _)| *at).map(|(_, offered)| offered.clone());
    offered(&|at| at < now).or_else(|| offered(&|at| at == now))
}

/// The try after `tries` tries of a piece on `agent`, the last of which ran
/// `model` at `effort` on `tier`. `models` is what the agents' CLIs list.
pub fn next(agent: &str, tries: usize, model: &str, effort: Option<&str>, tier: Option<Tier>, models: &[Model]) -> Verdict {
    let entry = routing::listed(agent, model, models);
    match tries {
        // Steps 1 and 2: the failure text, and one more level of effort where there is one.
        0 | 1 => Verdict::Again(match raised(effort, entry) {
            Some(effort) => Next { step: Step::Effort, model: model.to_string(), effort: Some(effort), tier },
            None => Next { step: Step::Retry, model: model.to_string(), effort: effort.map(str::to_owned), tier },
        }),
        // Step 3: the next tier up.
        tries if tries < MAX_TRIES => {
            let Some(now) = tier else {
                return Verdict::Blocked(format!("{} is not a model of a known tier, so there is no tier above it to move to.", if model.is_empty() { "The agent's default model" } else { model }));
            };
            let Some(above) = now.above() else {
                return Verdict::Blocked("It already ran on the top tier: there is no model above it.".into());
            };
            match routing::model_for(agent, above, models) {
                Some(up) => Verdict::Again(Next { step: Step::Tier, model: up.id.clone(), effort: lowered(effective(effort, entry).as_deref(), up), tier: Some(above) }),
                None => Verdict::Blocked(format!("No {} model of {} is installed ({}), so there is no model above it to move to.", above.name(), routing::agent_name(agent), above.family(agent).unwrap_or_default())),
            }
        }
        // Step 4.
        _ => Verdict::Blocked(format!("It used all {MAX_TRIES} tries.")),
    }
}

/// How a step reads in the line that says what was tried.
pub fn describe(step: Step) -> &'static str {
    match step {
        Step::First => "first try",
        Step::Retry => "tried again with the failure text",
        Step::Effort => "tried again with the failure text, effort raised one level",
        Step::Tier => "moved up one model at one effort level lower",
        Step::Widened => "tried again with its files widened",
        Step::Lead => "taken over by the lead",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::routing::tests::installed;

    fn again(agent: &str, tries: usize, model: &str, effort: Option<&str>, tier: Option<Tier>) -> Next {
        match next(agent, tries, model, effort, tier, &installed()) {
            Verdict::Again(next) => next,
            Verdict::Blocked(why) => panic!("expected another try, got blocked: {why}"),
        }
    }

    fn blocked(agent: &str, tries: usize, model: &str, effort: Option<&str>, tier: Option<Tier>) -> String {
        match next(agent, tries, model, effort, tier, &installed()) {
            Verdict::Blocked(why) => why,
            Verdict::Again(next) => panic!("expected blocked, got {next:?}"),
        }
    }

    #[test]
    fn a_failing_piece_takes_the_four_steps_in_order_and_stops_at_three_tries() {
        // Sonnet at medium, as the table starts a `scoped-code` piece.
        let second = again("claude", 1, "sonnet", Some("medium"), Some(Tier::Mid));
        assert_eq!(second, Next { step: Step::Effort, model: "sonnet".into(), effort: Some("high".into()), tier: Some(Tier::Mid) });
        let third = again("claude", 2, &second.model, second.effort.as_deref(), second.tier);
        assert_eq!(third, Next { step: Step::Tier, model: "opus".into(), effort: Some("medium".into()), tier: Some(Tier::Large) });
        assert_eq!(blocked("claude", 3, &third.model, third.effort.as_deref(), third.tier), "It used all 3 tries.");
        // The same on Codex, by family name.
        let second = again("codex", 1, "gpt-6.1-terra", Some("medium"), Some(Tier::Mid));
        assert_eq!((second.step, second.model.as_str(), second.effort.as_deref()), (Step::Effort, "gpt-6.1-terra", Some("high")));
        let third = again("codex", 2, &second.model, second.effort.as_deref(), second.tier);
        assert_eq!((third.step, third.model.as_str(), third.effort.as_deref(), third.tier), (Step::Tier, "gpt-6.1-sol", Some("medium"), Some(Tier::Large)));
        assert!(matches!(next("codex", 3, &third.model, third.effort.as_deref(), third.tier, &installed()), Verdict::Blocked(_)));
        assert!(matches!(next("codex", 7, &third.model, third.effort.as_deref(), third.tier, &installed()), Verdict::Blocked(_)));
    }

    #[test]
    fn effort_is_never_raised_past_high() {
        let models = installed();
        // From every effort a model offers, on every model: the next try is at most high.
        for model in models.iter().filter(|model| model.harness == "claude" || model.harness == "codex") {
            for effort in model.efforts.iter().map(|effort| Some(effort.as_str())).chain([None]) {
                let Verdict::Again(next) = next(&model.harness, 1, &model.id, effort, routing::tier_of(&model.harness, &model.id), &models) else { panic!("the second try is always made") };
                let before = effective(effort, Some(model)).and_then(|effort| level(&effort));
                let after = effective(next.effort.as_deref(), Some(model)).and_then(|effort| level(&effort));
                match next.step {
                    Step::Effort => {
                        assert!(after <= level("high"), "{} raised {effort:?} to {:?}", model.id, next.effort);
                        assert_eq!(after, before.map(|level| level + 1), "{} goes up one level from {effort:?}", model.id);
                    }
                    // Not raised: the same effort again.
                    _ => assert_eq!((next.step, next.effort.as_deref()), (Step::Retry, effort), "{} at {effort:?}", model.id),
                }
            }
        }
        // At high and above, the second try is a plain retry at the same effort.
        for effort in ["high", "xhigh", "max"] {
            assert_eq!(again("claude", 1, "opus", Some(effort), Some(Tier::Large)), Next { step: Step::Retry, model: "opus".into(), effort: Some(effort.into()), tier: Some(Tier::Large) });
        }
        // Low goes to medium, not straight to high.
        assert_eq!(again("claude", 1, "opus", Some("low"), Some(Tier::Large)).effort.as_deref(), Some("medium"));
        // A model's own default counts: Sol ships at low, so its default goes up to medium.
        assert_eq!(again("codex", 1, "gpt-6.1-sol", None, Some(Tier::Large)).effort.as_deref(), Some("medium"));
    }

    #[test]
    fn a_model_with_no_effort_levels_is_tried_again_as_it_is_then_moved_up() {
        // Haiku at its own default, as the table starts a `search` piece.
        let second = again("claude", 1, "haiku", None, Some(Tier::Small));
        assert_eq!(second, Next { step: Step::Retry, model: "haiku".into(), effort: None, tier: Some(Tier::Small) });
        // No effort was named, so none is named on the model above: its own default runs.
        let third = again("claude", 2, "haiku", None, Some(Tier::Small));
        assert_eq!(third, Next { step: Step::Tier, model: "sonnet".into(), effort: None, tier: Some(Tier::Mid) });
    }

    #[test]
    fn the_model_above_runs_one_effort_level_lower_among_those_it_offers() {
        // High on Sonnet becomes medium on Opus; low has nothing below it and stays.
        assert_eq!(again("claude", 2, "sonnet", Some("high"), Some(Tier::Mid)).effort.as_deref(), Some("medium"));
        assert_eq!(again("claude", 2, "sonnet", Some("low"), Some(Tier::Mid)).effort.as_deref(), Some("low"));
        assert_eq!(again("claude", 2, "sonnet", Some("max"), Some(Tier::Mid)).effort.as_deref(), Some("xhigh"));
        // Luna at its default (low) moves up to Terra at low.
        assert_eq!(again("codex", 2, "gpt-6-luna", None, Some(Tier::Small)), Next { step: Step::Tier, model: "gpt-6.1-terra".into(), effort: Some("low".into()), tier: Some(Tier::Mid) });
    }

    #[test]
    fn a_piece_with_no_model_above_it_is_blocked_after_two_tries() {
        assert_eq!(blocked("claude", 2, "fable", Some("high"), Some(Tier::Top)), "It already ran on the top tier: there is no model above it.");
        // A model of no family (the plan named it) has no tier to move up from.
        assert!(blocked("codex", 2, "gpt-5.5", Some("high"), None).starts_with("gpt-5.5 is not a model of a known tier"));
        assert!(blocked("codex", 2, "", None, None).starts_with("The agent's default model is not a model of a known tier"));
        // The tier above is not installed: what Codex lists today has no Astra.
        let mut models = crate::models::claude_fallback();
        models.extend(crate::harness::codex::models::fallback());
        assert_eq!(next("codex", 2, "gpt-5.6-sol", Some("high"), Some(Tier::Large), &models), Verdict::Blocked("No top model of Codex is installed (astra), so there is no model above it to move to.".into()));
        // The second try is still made for each of them.
        assert_eq!(again("claude", 1, "fable", Some("medium"), Some(Tier::Top)).step, Step::Effort);
    }
}
