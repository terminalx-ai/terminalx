//! What a piece tries next when a try falls short (PRO-275).
//!
//! A try falls short when its worker reports `failed` or `partial`, or when
//! the piece's done-check fails. The steps, in order:
//!
//! 1. Try again with the failure text in the brief.
//! 2. Raise the effort one level, never past the run's effort ceiling
//!    (`high` unless Settings say otherwise): one more level can cost as much
//!    as the next model up.
//! 3. Move up one model tier, at one effort level lower.
//! 4. Stop: the piece is `blocked` and goes back to the lead with what was tried.
//!
//! A piece gets the run's tries per piece ([`Rules::tries`], three unless
//! Settings say otherwise), the first included. The second try takes steps 1
//! and 2 together (the failure text, and the effort raised where it can be)
//! and the third takes step 3. Past three the two alternate: the fourth
//! raises the effort on the model the third moved to, the fifth moves up a
//! tier again, and so on, so every try changes one thing the one before did
//! not. A move up with no tier above it ends the climb, as it does at three.
//! One try per piece blocks a piece after its first; two give it the effort
//! step only. Every try after the first is a fresh worker: a model switch
//! loses the prompt cache anyway, and a smaller model cannot read a larger
//! one's reasoning.
//!
//! Nothing here starts anything. [`next`] only says what the next try runs on.

use serde::{Deserialize, Serialize};

use super::routing::{self, Tier, EFFORTS};
use crate::models::Model;

/// The tries a piece gets, the first included, when Settings say nothing:
/// one retry and one move up.
pub const DEFAULT_TRIES_PER_PIECE: u32 = 3;
/// The most tries Settings accept: past the first, three effort steps and
/// two moves up, enough to climb from the mid tier to the top. A piece that
/// falls short that often is better back with the lead.
pub const MAX_TRIES_PER_PIECE: u32 = 6;
/// Escalation never raises effort past this when Settings say nothing.
pub const DEFAULT_EFFORT_CEILING: &str = "high";

/// Whether `tries` is a count of tries per piece Settings accept.
pub fn valid_tries(tries: u32) -> bool {
    (1..=MAX_TRIES_PER_PIECE).contains(&tries)
}

/// Whether `effort` is a level escalation may stop at: one of [`EFFORTS`].
pub fn valid_ceiling(effort: &str) -> bool {
    EFFORTS.contains(&effort)
}

/// How far one run's pieces climb: copied from the project's settings when
/// the run is made, so a later change in Settings does not alter its ladder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// The tries a piece gets, the first included.
    pub tries: u32,
    /// Escalation never raises effort past this level.
    pub ceiling: String,
}

impl Default for Rules {
    fn default() -> Self {
        Self { tries: DEFAULT_TRIES_PER_PIECE, ceiling: DEFAULT_EFFORT_CEILING.into() }
    }
}

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

/// One level up among the efforts `model` offers, never past `ceiling`.
fn raised(effort: Option<&str>, model: Option<&Model>, ceiling: &str) -> Option<String> {
    let model = model?;
    let now = level(&effective(effort, Some(model))?)?;
    let ceiling = level(ceiling)?;
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
/// `model` at `effort` on `tier`, under the run's `rules`. `models` is what
/// the agents' CLIs list.
///
/// Tries 2, 4 and 6 take the effort step (a plain retry where the effort
/// cannot go up); tries 3 and 5 move up a tier. See the module doc.
pub fn next(agent: &str, tries: usize, rules: &Rules, model: &str, effort: Option<&str>, tier: Option<Tier>, models: &[Model]) -> Verdict {
    let allowed = rules.tries.max(1) as usize;
    if tries >= allowed {
        // Step 4.
        return Verdict::Blocked(match allowed {
            1 => "It had its one try: the run gives a piece no more.".into(),
            allowed => format!("It used all {allowed} tries."),
        });
    }
    let entry = routing::listed(agent, model, models);
    // An odd count of tries so far (or none) is followed by the effort step; an even count by a move up.
    if tries % 2 == 1 || tries == 0 {
        // Steps 1 and 2: the failure text, and one more level of effort where there is one.
        return Verdict::Again(match raised(effort, entry, &rules.ceiling) {
            Some(effort) => Next { step: Step::Effort, model: model.to_string(), effort: Some(effort), tier },
            None => Next { step: Step::Retry, model: model.to_string(), effort: effort.map(str::to_owned), tier },
        });
    }
    // Step 3: the next tier up.
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
        match next(agent, tries, &Rules::default(), model, effort, tier, &installed()) {
            Verdict::Again(next) => next,
            Verdict::Blocked(why) => panic!("expected another try, got blocked: {why}"),
        }
    }

    fn blocked(agent: &str, tries: usize, model: &str, effort: Option<&str>, tier: Option<Tier>) -> String {
        match next(agent, tries, &Rules::default(), model, effort, tier, &installed()) {
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
        assert!(matches!(next("codex", 3, &Rules::default(), &third.model, third.effort.as_deref(), third.tier, &installed()), Verdict::Blocked(_)));
        assert!(matches!(next("codex", 7, &Rules::default(), &third.model, third.effort.as_deref(), third.tier, &installed()), Verdict::Blocked(_)));
    }

    #[test]
    fn effort_is_never_raised_past_high() {
        let models = installed();
        // From every effort a model offers, on every model: the next try is at most high.
        for model in models.iter().filter(|model| model.harness == "claude" || model.harness == "codex") {
            for effort in model.efforts.iter().map(|effort| Some(effort.as_str())).chain([None]) {
                let Verdict::Again(next) = next(&model.harness, 1, &Rules::default(), &model.id, effort, routing::tier_of(&model.harness, &model.id), &models) else { panic!("the second try is always made") };
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
        assert_eq!(next("codex", 2, &Rules::default(), "gpt-5.6-sol", Some("high"), Some(Tier::Large), &models), Verdict::Blocked("No top model of Codex is installed (astra), so there is no model above it to move to.".into()));
        // The second try is still made for each of them.
        assert_eq!(again("claude", 1, "fable", Some("medium"), Some(Tier::Top)).step, Step::Effort);
    }

    fn under(rules: &Rules, agent: &str, tries: usize, last: &Next) -> Verdict {
        next(agent, tries, rules, &last.model, last.effort.as_deref(), last.tier, &installed())
    }

    #[test]
    fn one_try_per_piece_blocks_a_piece_after_its_first() {
        let rules = Rules { tries: 1, ..Rules::default() };
        assert_eq!(next("claude", 1, &rules, "sonnet", Some("medium"), Some(Tier::Mid), &installed()), Verdict::Blocked("It had its one try: the run gives a piece no more.".into()));
    }

    #[test]
    fn two_tries_per_piece_give_the_effort_step_only() {
        let rules = Rules { tries: 2, ..Rules::default() };
        let first = Next { step: Step::First, model: "sonnet".into(), effort: Some("medium".into()), tier: Some(Tier::Mid) };
        let Verdict::Again(second) = under(&rules, "claude", 1, &first) else { panic!("the second try is made") };
        assert_eq!((second.step, second.effort.as_deref()), (Step::Effort, Some("high")));
        assert_eq!(under(&rules, "claude", 2, &second), Verdict::Blocked("It used all 2 tries.".into()));
    }

    #[test]
    fn six_tries_alternate_the_effort_step_and_a_move_up() {
        let rules = Rules { tries: 6, ..Rules::default() };
        let mut last = Next { step: Step::First, model: "sonnet".into(), effort: Some("low".into()), tier: Some(Tier::Mid) };
        let mut climbed = Vec::new();
        for tries in 1..6 {
            let Verdict::Again(now) = under(&rules, "claude", tries, &last) else { panic!("try {} is made", tries + 1) };
            climbed.push((now.step, now.model.clone(), now.effort.clone().unwrap_or_default()));
            last = now;
        }
        let step = |step: Step, model: &str, effort: &str| (step, model.to_string(), effort.to_string());
        assert_eq!(climbed, vec![
            step(Step::Effort, "sonnet", "medium"),
            step(Step::Tier, "opus", "low"),
            step(Step::Effort, "opus", "medium"),
            step(Step::Tier, "fable", "low"),
            step(Step::Effort, "fable", "medium"),
        ]);
        assert_eq!(under(&rules, "claude", 6, &last), Verdict::Blocked("It used all 6 tries.".into()));
        // A move up from the top tier still ends the climb before the tries run out.
        let fable = Next { step: Step::Effort, model: "fable".into(), effort: Some("high".into()), tier: Some(Tier::Top) };
        assert_eq!(under(&rules, "claude", 4, &fable), Verdict::Blocked("It already ran on the top tier: there is no model above it.".into()));
    }

    #[test]
    fn the_effort_ceiling_is_the_runs_own() {
        let at = |ceiling: &str| Rules { ceiling: ceiling.into(), ..Rules::default() };
        let sonnet_high = Next { step: Step::First, model: "sonnet".into(), effort: Some("high".into()), tier: Some(Tier::Mid) };
        // Under the default ceiling high is as far as it goes; under max it goes one level on, and no more.
        assert_eq!(under(&Rules::default(), "claude", 1, &sonnet_high), Verdict::Again(Next { step: Step::Retry, ..sonnet_high.clone() }));
        let Verdict::Again(raised) = under(&at("max"), "claude", 1, &sonnet_high) else { panic!("the second try is made") };
        assert_eq!((raised.step, raised.effort.as_deref()), (Step::Effort, Some("xhigh")));
        // Under medium a piece at low goes to medium, and one at medium is retried as it is.
        let low = Next { effort: Some("low".into()), ..sonnet_high.clone() };
        assert_eq!(under(&at("medium"), "claude", 1, &low), Verdict::Again(Next { step: Step::Effort, effort: Some("medium".into()), ..sonnet_high.clone() }));
        let medium = Next { effort: Some("medium".into()), ..sonnet_high.clone() };
        assert_eq!(under(&at("medium"), "claude", 1, &medium), Verdict::Again(Next { step: Step::Retry, ..medium.clone() }));
        // Under low nothing is raised at all.
        assert_eq!(under(&at("low"), "claude", 1, &low), Verdict::Again(Next { step: Step::Retry, ..low.clone() }));
    }

    #[test]
    fn at_every_ceiling_the_effort_step_goes_up_one_level_and_stops_there() {
        let models = installed();
        for ceiling in EFFORTS {
            let rules = Rules { ceiling: ceiling.to_string(), ..Rules::default() };
            let top = level(ceiling).unwrap();
            for model in models.iter().filter(|model| model.harness == "claude" || model.harness == "codex") {
                for effort in &model.efforts {
                    let Verdict::Again(next) = next(&model.harness, 1, &rules, &model.id, Some(effort), routing::tier_of(&model.harness, &model.id), &models) else { panic!("the second try is always made") };
                    let (before, after) = (level(effort), next.effort.as_deref().and_then(level));
                    match next.step {
                        Step::Effort => assert!(after > before && after <= Some(top), "{} under {ceiling}: {effort} to {:?}", model.id, next.effort),
                        // Not raised: the same effort again, and only because nothing the model offers lies between it and the ceiling.
                        _ => {
                            assert_eq!((next.step, next.effort.as_deref()), (Step::Retry, Some(effort.as_str())), "{} under {ceiling}", model.id);
                            assert!(!model.efforts.iter().filter_map(|offered| level(offered)).any(|at| Some(at) > before && at <= top), "{} under {ceiling} could have gone up from {effort}", model.id);
                        }
                    }
                }
            }
        }
    }
}
