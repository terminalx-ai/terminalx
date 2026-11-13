//! What a piece tries next when a try falls short (PRO-275).
//!
//! A try falls short when its worker reports `failed` or `partial`, or when
//! the piece's done-check fails. The steps, in order:
//!
//! 1. Try again with the failure text in the brief.
//! 2. Raise the effort one level, never past the run's effort ceiling (High
//!    unless Settings say otherwise): one more level can cost as much as the
//!    next model up.
//! 3. Move up one model tier, at one effort level lower.
//! 4. Stop: the piece is `blocked` and goes back to the lead with what was tried.
//!
//! A piece gets at most [`Ladder::max_tries`] tries, the first included
//! (Settings → Orchestrator, Tries per piece; three unless changed). With
//! three, the second try takes steps 1 and 2 together (the failure text, and
//! the effort raised where it can be) and the third takes step 3. Every try
//! after the first is a fresh worker: a model switch loses the prompt cache
//! anyway, and a smaller model cannot read a larger one's reasoning.
//!
//! Past three tries the ladder keeps climbing in the same rhythm rather than
//! repeating a step: a try that moved up a tier is followed by one that
//! raises the effort on that model (skipped, straight to the next tier, when
//! it is already at the ceiling), and that by the next tier up. A piece that
//! can neither raise its effort nor move up is blocked before its tries run
//! out. With one try the piece is blocked after its first; with two the
//! second try is step 1 and 2 and nothing follows it.
//!
//! Nothing here starts anything. [`next`] only says what the next try runs on.

use serde::{Deserialize, Serialize};

use super::routing::{self, Tier, EFFORTS};
use crate::models::Model;

/// The most tries a piece gets when nothing says otherwise, the first included.
pub const DEFAULT_MAX_TRIES: u32 = 3;
/// The fewest and most tries the setting takes.
pub const MIN_TRIES: u32 = 1;
pub const MAX_TRIES: u32 = 6;
/// Escalation never raises effort past this when nothing says otherwise.
pub const DEFAULT_EFFORT_CEILING: &str = "high";

/// Whether `tries` is a value Tries per piece takes.
pub fn valid_tries(tries: u32) -> bool {
    (MIN_TRIES..=MAX_TRIES).contains(&tries)
}

/// Whether `effort` is a level Raise effort no higher than takes.
pub fn valid_ceiling(effort: &str) -> bool {
    EFFORTS.contains(&effort)
}

/// How far one run's pieces climb: taken from the project's settings when
/// the run is created, and kept, so a later change to the settings does not
/// alter a run under way. A run stored before these were kept reads as the
/// defaults, three tries and High.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ladder {
    /// The most tries a piece gets, the first included.
    #[serde(default = "default_max_tries")]
    pub max_tries: u32,
    /// Escalation never raises effort past this level of [`EFFORTS`].
    #[serde(default = "default_effort_ceiling")]
    pub effort_ceiling: String,
}

fn default_max_tries() -> u32 {
    DEFAULT_MAX_TRIES
}

fn default_effort_ceiling() -> String {
    DEFAULT_EFFORT_CEILING.into()
}

impl Default for Ladder {
    fn default() -> Self {
        Self { max_tries: DEFAULT_MAX_TRIES, effort_ceiling: DEFAULT_EFFORT_CEILING.into() }
    }
}

impl Ladder {
    pub fn new(max_tries: u32, effort_ceiling: &str) -> Self {
        Self { max_tries, effort_ceiling: effort_ceiling.into() }
    }
}

/// The try that fell short, as the ladder reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Last<'a> {
    pub step: Step,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub tier: Option<Tier>,
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

/// The try after `tries` tries of a piece on `agent`, the last of which is
/// `last`. `models` is what the agents' CLIs list; `ladder` is the run's own
/// tries and effort ceiling.
pub fn next(agent: &str, tries: usize, last: Last, models: &[Model], ladder: &Ladder) -> Verdict {
    let max = ladder.max_tries.max(MIN_TRIES) as usize;
    // Step 4: every try is used.
    if tries >= max {
        return Verdict::Blocked(format!("It used all {max} {}.", if max == 1 { "try" } else { "tries" }));
    }
    let Last { model, effort, tier, .. } = last;
    let entry = routing::listed(agent, model, models);
    let raise = || raised(effort, entry, &ladder.effort_ceiling).map(|effort| Next { step: Step::Effort, model: model.to_string(), effort: Some(effort), tier });
    // Steps 1 and 2: the failure text, and one more level of effort where there is one.
    if tries <= 1 {
        return Verdict::Again(raise().unwrap_or_else(|| Next { step: Step::Retry, model: model.to_string(), effort: effort.map(str::to_owned), tier }));
    }
    // Past three tries: a model just moved up to is first tried at more effort.
    if last.step == Step::Tier {
        if let Some(next) = raise() {
            return Verdict::Again(next);
        }
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

    /// The step a try took on the three-try ladder: the first, then the effort step.
    fn after(tries: usize) -> Step {
        if tries <= 1 { Step::First } else { Step::Effort }
    }

    fn last<'a>(tries: usize, model: &'a str, effort: Option<&'a str>, tier: Option<Tier>) -> Last<'a> {
        Last { step: after(tries), model, effort, tier }
    }

    fn on(ladder: &Ladder, agent: &str, tries: usize, last: Last) -> Verdict {
        next(agent, tries, last, &installed(), ladder)
    }

    fn again(agent: &str, tries: usize, model: &str, effort: Option<&str>, tier: Option<Tier>) -> Next {
        match on(&Ladder::default(), agent, tries, last(tries, model, effort, tier)) {
            Verdict::Again(next) => next,
            Verdict::Blocked(why) => panic!("expected another try, got blocked: {why}"),
        }
    }

    fn blocked(agent: &str, tries: usize, model: &str, effort: Option<&str>, tier: Option<Tier>) -> String {
        match on(&Ladder::default(), agent, tries, last(tries, model, effort, tier)) {
            Verdict::Blocked(why) => why,
            Verdict::Again(next) => panic!("expected blocked, got {next:?}"),
        }
    }

    #[test]
    fn ladder_a_failing_piece_takes_the_four_steps_in_order_and_stops_at_three_tries() {
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
        assert!(matches!(on(&Ladder::default(), "codex", 3, Last { step: Step::Tier, model: &third.model, effort: third.effort.as_deref(), tier: third.tier }), Verdict::Blocked(_)));
        assert!(matches!(on(&Ladder::default(), "codex", 7, Last { step: Step::Tier, model: &third.model, effort: third.effort.as_deref(), tier: third.tier }), Verdict::Blocked(_)));
    }

    #[test]
    fn ladder_effort_is_never_raised_past_high() {
        let models = installed();
        // From every effort a model offers, on every model: the next try is at most high.
        for model in models.iter().filter(|model| model.harness == "claude" || model.harness == "codex") {
            for effort in model.efforts.iter().map(|effort| Some(effort.as_str())).chain([None]) {
                let Verdict::Again(next) = next(&model.harness, 1, Last { step: Step::First, model: &model.id, effort, tier: routing::tier_of(&model.harness, &model.id) }, &models, &Ladder::default()) else { panic!("the second try is always made") };
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
    fn ladder_a_model_with_no_effort_levels_is_tried_again_as_it_is_then_moved_up() {
        // Haiku at its own default, as the table starts a `search` piece.
        let second = again("claude", 1, "haiku", None, Some(Tier::Small));
        assert_eq!(second, Next { step: Step::Retry, model: "haiku".into(), effort: None, tier: Some(Tier::Small) });
        // No effort was named, so none is named on the model above: its own default runs.
        let third = again("claude", 2, "haiku", None, Some(Tier::Small));
        assert_eq!(third, Next { step: Step::Tier, model: "sonnet".into(), effort: None, tier: Some(Tier::Mid) });
    }

    #[test]
    fn ladder_the_model_above_runs_one_effort_level_lower_among_those_it_offers() {
        // High on Sonnet becomes medium on Opus; low has nothing below it and stays.
        assert_eq!(again("claude", 2, "sonnet", Some("high"), Some(Tier::Mid)).effort.as_deref(), Some("medium"));
        assert_eq!(again("claude", 2, "sonnet", Some("low"), Some(Tier::Mid)).effort.as_deref(), Some("low"));
        assert_eq!(again("claude", 2, "sonnet", Some("max"), Some(Tier::Mid)).effort.as_deref(), Some("xhigh"));
        // Luna at its default (low) moves up to Terra at low.
        assert_eq!(again("codex", 2, "gpt-6-luna", None, Some(Tier::Small)), Next { step: Step::Tier, model: "gpt-6.1-terra".into(), effort: Some("low".into()), tier: Some(Tier::Mid) });
    }

    #[test]
    fn ladder_a_piece_with_no_model_above_it_is_blocked_after_two_tries() {
        assert_eq!(blocked("claude", 2, "fable", Some("high"), Some(Tier::Top)), "It already ran on the top tier: there is no model above it.");
        // A model of no family (the plan named it) has no tier to move up from.
        assert!(blocked("codex", 2, "gpt-5.5", Some("high"), None).starts_with("gpt-5.5 is not a model of a known tier"));
        assert!(blocked("codex", 2, "", None, None).starts_with("The agent's default model is not a model of a known tier"));
        // The tier above is not installed: what Codex lists today has no Astra.
        let mut models = crate::models::claude_fallback();
        models.extend(crate::harness::codex::models::fallback());
        assert_eq!(next("codex", 2, last(2, "gpt-5.6-sol", Some("high"), Some(Tier::Large)), &models, &Ladder::default()), Verdict::Blocked("No top model of Codex is installed (astra), so there is no model above it to move to.".into()));
        // The second try is still made for each of them.
        assert_eq!(again("claude", 1, "fable", Some("medium"), Some(Tier::Top)).step, Step::Effort);
    }

    /// Every try of a piece on `agent` that keeps falling short, from `first`, until it is blocked.
    fn climb_all(ladder: &Ladder, agent: &str, first: Next) -> (Vec<Next>, String) {
        let mut tries = vec![first];
        loop {
            let at = tries.last().unwrap();
            let last = Last { step: at.step, model: &at.model, effort: at.effort.as_deref(), tier: at.tier };
            match on(ladder, agent, tries.len(), last) {
                Verdict::Again(next) => tries.push(next),
                Verdict::Blocked(why) => return (tries, why),
            }
            assert!(tries.len() <= MAX_TRIES as usize, "the ladder never runs past the most the setting takes");
        }
    }

    fn sonnet_at_medium() -> Next {
        Next { step: Step::First, model: "sonnet".into(), effort: Some("medium".into()), tier: Some(Tier::Mid) }
    }

    fn shape(tries: &[Next]) -> Vec<(Step, &str, Option<&str>)> {
        tries.iter().map(|next| (next.step, next.model.as_str(), next.effort.as_deref())).collect()
    }

    #[test]
    fn ladder_with_one_try_blocks_after_the_first() {
        let (tries, why) = climb_all(&Ladder::new(1, "high"), "claude", sonnet_at_medium());
        assert_eq!(tries.len(), 1);
        assert_eq!(why, "It used all 1 try.");
    }

    #[test]
    fn ladder_with_two_tries_raises_the_effort_once_then_blocks() {
        let (tries, why) = climb_all(&Ladder::new(2, "high"), "claude", sonnet_at_medium());
        assert_eq!(shape(&tries), vec![(Step::First, "sonnet", Some("medium")), (Step::Effort, "sonnet", Some("high"))]);
        assert_eq!(why, "It used all 2 tries.");
    }

    #[test]
    fn ladder_with_three_tries_is_the_shape_it_always_had() {
        let (tries, why) = climb_all(&Ladder::default(), "claude", sonnet_at_medium());
        assert_eq!(shape(&tries), vec![(Step::First, "sonnet", Some("medium")), (Step::Effort, "sonnet", Some("high")), (Step::Tier, "opus", Some("medium"))]);
        assert_eq!(why, "It used all 3 tries.");
    }

    #[test]
    fn ladder_with_six_tries_alternates_effort_and_tier_rather_than_repeating_a_step() {
        let (tries, why) = climb_all(&Ladder::new(6, "high"), "claude", sonnet_at_medium());
        assert_eq!(
            shape(&tries),
            vec![
                (Step::First, "sonnet", Some("medium")),
                (Step::Effort, "sonnet", Some("high")),
                (Step::Tier, "opus", Some("medium")),
                (Step::Effort, "opus", Some("high")),
                (Step::Tier, "fable", Some("medium")),
                (Step::Effort, "fable", Some("high")),
            ]
        );
        assert_eq!(why, "It used all 6 tries.");
        // From a start where nothing is left to climb, six tries end early with the reason.
        let top = Next { step: Step::First, model: "fable".into(), effort: Some("high".into()), tier: Some(Tier::Top) };
        let (tries, why) = climb_all(&Ladder::new(6, "high"), "claude", top);
        assert_eq!(shape(&tries), vec![(Step::First, "fable", Some("high")), (Step::Retry, "fable", Some("high"))]);
        assert_eq!(why, "It already ran on the top tier: there is no model above it.");
    }

    #[test]
    fn ladder_at_the_ceiling_after_a_tier_step_moves_up_again() {
        // A ceiling of low: no model after a move up can be raised, so each try after the second is the tier above,
        // never an effort step. (A tier step runs one level below the last effort, as always: the ceiling bounds raising.)
        let low = Ladder::new(6, "low");
        let (tries, why) = climb_all(&low, "claude", Next { step: Step::First, model: "haiku".into(), effort: None, tier: Some(Tier::Small) });
        assert_eq!(shape(&tries), vec![(Step::First, "haiku", None), (Step::Retry, "haiku", None), (Step::Tier, "sonnet", None), (Step::Tier, "opus", Some("medium")), (Step::Tier, "fable", Some("low"))]);
        assert!(tries.iter().all(|next| next.step != Step::Effort), "{tries:?}");
        assert_eq!(why, "It already ran on the top tier: there is no model above it.");
    }

    #[test]
    fn ladder_effort_ceiling_holds_at_each_level() {
        // From low on Opus, which offers every level: the effort step stops at the ceiling.
        for (ceiling, raised) in [("low", None), ("medium", Some("medium")), ("high", Some("medium")), ("xhigh", Some("medium")), ("max", Some("medium"))] {
            let next = match on(&Ladder::new(3, ceiling), "claude", 1, Last { step: Step::First, model: "opus", effort: Some("low"), tier: Some(Tier::Large) }) {
                Verdict::Again(next) => next,
                Verdict::Blocked(why) => panic!("{why}"),
            };
            match raised {
                Some(effort) => assert_eq!((next.step, next.effort.as_deref()), (Step::Effort, Some(effort)), "ceiling {ceiling}"),
                None => assert_eq!((next.step, next.effort.as_deref()), (Step::Retry, Some("low")), "ceiling {ceiling}"),
            }
        }
        // From medium: a ceiling of medium stops the effort step at medium, and each higher ceiling lets it go one level.
        for (ceiling, expected) in [("low", (Step::Retry, "medium")), ("medium", (Step::Retry, "medium")), ("high", (Step::Effort, "high")), ("xhigh", (Step::Effort, "high")), ("max", (Step::Effort, "high"))] {
            let Verdict::Again(next) = on(&Ladder::new(3, ceiling), "claude", 1, Last { step: Step::First, model: "opus", effort: Some("medium"), tier: Some(Tier::Large) }) else { panic!() };
            assert_eq!((next.step, next.effort.as_deref().unwrap()), expected, "ceiling {ceiling}");
        }
        // From high: only xhigh and max let it go further.
        for (ceiling, expected) in [("high", (Step::Retry, "high")), ("xhigh", (Step::Effort, "xhigh")), ("max", (Step::Effort, "xhigh"))] {
            let Verdict::Again(next) = on(&Ladder::new(3, ceiling), "claude", 1, Last { step: Step::First, model: "opus", effort: Some("high"), tier: Some(Tier::Large) }) else { panic!() };
            assert_eq!((next.step, next.effort.as_deref().unwrap()), expected, "ceiling {ceiling}");
        }
        // From xhigh, a ceiling of max raises it to max.
        let Verdict::Again(next) = on(&Ladder::new(3, "max"), "claude", 1, Last { step: Step::First, model: "opus", effort: Some("xhigh"), tier: Some(Tier::Large) }) else { panic!() };
        assert_eq!((next.step, next.effort.as_deref()), (Step::Effort, Some("max")));
        // A ceiling of medium on six tries: no try past the first runs above medium.
        let (tries, _) = climb_all(&Ladder::new(6, "medium"), "claude", Next { step: Step::First, model: "sonnet".into(), effort: Some("low".into()), tier: Some(Tier::Mid) });
        assert!(tries.iter().all(|next| next.effort.as_deref().and_then(level) <= level("medium")), "{tries:?}");
    }

    #[test]
    fn ladder_of_a_run_stored_before_it_was_kept_reads_as_three_tries_and_high() {
        let old: Ladder = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(old, Ladder { max_tries: 3, effort_ceiling: "high".into() });
        assert_eq!(serde_json::to_value(Ladder::new(5, "medium")).unwrap(), serde_json::json!({"maxTries": 5, "effortCeiling": "medium"}));
        assert!(valid_tries(1) && valid_tries(6) && !valid_tries(0) && !valid_tries(7));
        assert!(EFFORTS.iter().all(|effort| valid_ceiling(effort)) && !valid_ceiling("none") && !valid_ceiling("High"));
    }
}
