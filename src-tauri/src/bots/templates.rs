//! The role templates bundled with the app (PRO-466). A template is a title,
//! a one-line description, the `ROLE.md` text, the skills it suggests and
//! its duties as data. It carries no credentials and no permissions, and
//! every duty arrives switched off.

use serde::Serialize;

/// What wakes a duty. Data only: nothing here is scheduled or subscribed to
/// until a person switches the duty on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DutyWake {
    Schedule { cron: &'static str },
    Github { event: &'static str },
    Linear { event: &'static str },
    /// Another bot hands it work.
    Bot,
    /// A person writes to it.
    Message,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDuty {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub wake: DutyWake,
    /// Always `false` in a template.
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleTemplate {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// The standing instructions a new bot's `ROLE.md` starts from.
    pub role: &'static str,
    pub skills: &'static [&'static str],
    pub duties: Vec<TemplateDuty>,
}

fn duty(id: &'static str, title: &'static str, description: &'static str, wake: DutyWake) -> TemplateDuty {
    TemplateDuty { id, title, description, wake, enabled: false }
}

fn schedule(cron: &'static str) -> DutyWake {
    DutyWake::Schedule { cron }
}

/// Every bundled template, in the order the hiring screen offers them.
pub fn all() -> Vec<RoleTemplate> {
    vec![
        RoleTemplate {
            id: "cto",
            title: "CTO",
            description: "Leads the other bots, splits large work into orchestration runs, reviews plans and reports status.",
            role: include_str!("roles/cto.md"),
            skills: &["terminalx-cli", "terminalx-orchestrator"],
            duties: vec![
                duty("status-report", "Status report", "Each weekday morning, report what is done, in progress and blocked.", schedule("0 9 * * 1-5")),
                duty("take-problems", "Take problems from the other bots", "Receive a failure or a question from another bot and decide what it needs.", DutyWake::Bot),
                duty("review-plans", "Review plans", "Review a pull request's plan and scope when it opens.", DutyWake::Github { event: "pull_request.opened" }),
            ],
        },
        RoleTemplate {
            id: "chief-of-staff",
            title: "Chief of staff",
            description: "Keeps the open work in order and briefs you on what needs a decision.",
            role: include_str!("roles/chief-of-staff.md"),
            skills: &["terminalx-cli"],
            duties: vec![
                duty("morning-brief", "Morning brief", "Each weekday morning, say what changed, what needs a decision and what is late.", schedule("0 8 * * 1-5")),
                duty("chase-quiet-work", "Chase quiet work", "Each weekday afternoon, ask after work that has gone quiet.", schedule("0 15 * * 1-5")),
                duty("file-requests", "File requests", "Turn a request you send into an issue with a goal and a done condition.", DutyWake::Message),
            ],
        },
        RoleTemplate {
            id: "ux-designer",
            title: "UX designer",
            description: "Reviews interface changes against the designs, fixes jumbled UI and prepares screens.",
            role: include_str!("roles/ux-designer.md"),
            skills: &["terminalx-cli", "computer-use", "local-vm"],
            duties: vec![
                duty("review-interface-changes", "Review interface changes", "Compare a pull request's screens with the designs when it opens.", DutyWake::Github { event: "pull_request.opened" }),
                duty("layout-sweep", "Layout sweep", "Once a week, look through the app for jumbled, overlapping or clipped interface.", schedule("0 10 * * 1")),
            ],
        },
        RoleTemplate {
            id: "qa-engineer",
            title: "QA engineer",
            description: "Tests changes on the real app, reproduces bugs and tightens the tests.",
            role: include_str!("roles/qa-engineer.md"),
            skills: &["terminalx-cli", "computer-use", "local-vm"],
            duties: vec![
                duty("test-ready-changes", "Test ready changes", "Test a pull request against its issue when it is marked ready for review.", DutyWake::Github { event: "pull_request.ready_for_review" }),
                duty("reproduce-bugs", "Reproduce bugs", "Try to reproduce a new bug report and add the steps.", DutyWake::Linear { event: "issue.created" }),
                duty("nightly-regression", "Nightly regression", "Each night, run the regression checks on the default branch.", schedule("0 2 * * *")),
            ],
        },
        RoleTemplate {
            id: "release-manager",
            title: "Release manager",
            description: "Tracks what is ready to ship, checks the gates and writes the release notes.",
            role: include_str!("roles/release-manager.md"),
            skills: &["terminalx-cli"],
            duties: vec![
                duty("release-readiness", "Release readiness", "Once a week, list what has merged since the last release and what is still open.", schedule("0 10 * * 4")),
                duty("after-release-watch", "After-release watch", "When a release is published, watch for breakage and report it.", DutyWake::Github { event: "release.published" }),
            ],
        },
        RoleTemplate {
            id: "docs-writer",
            title: "Docs writer",
            description: "Keeps guides, reference and the changelog true to the product.",
            role: include_str!("roles/docs-writer.md"),
            skills: &["terminalx-cli"],
            duties: vec![
                duty("docs-for-merged-changes", "Docs for merged changes", "When a pull request merges, update the docs its change touches.", DutyWake::Github { event: "pull_request.merged" }),
                duty("stale-docs-sweep", "Stale docs sweep", "Once a week, look for documentation that no longer matches the code.", schedule("0 11 * * 3")),
            ],
        },
        RoleTemplate {
            id: "security-auditor",
            title: "Security auditor",
            description: "Reads pull requests and dependency changes for security problems and files findings. Reads and reports only.",
            role: include_str!("roles/security-auditor.md"),
            skills: &["terminalx-cli", "security-review"],
            duties: vec![
                duty("audit-pull-requests", "Audit pull requests", "Read a pull request for security problems when it opens.", DutyWake::Github { event: "pull_request.opened" }),
                duty("dependency-audit", "Dependency audit", "Once a week, read dependency changes and known advisories.", schedule("0 9 * * 1")),
            ],
        },
        RoleTemplate {
            id: "watcher",
            title: "Watcher",
            description: "Follows CI, pull requests, runs and stalled sessions; nudges or reports, and stays silent when nothing changed.",
            role: include_str!("roles/watcher.md"),
            skills: &["terminalx-cli"],
            duties: vec![
                duty("watch-ci", "Watch CI", "When a check fails, find the failing step and report it.", DutyWake::Github { event: "check_suite.completed" }),
                duty("watch-pull-requests", "Watch pull requests", "Every half hour, look for pull requests that are waiting, conflicting or forgotten.", schedule("*/30 * * * *")),
                duty("watch-stalled-sessions", "Watch stalled sessions", "Every quarter hour, look for runs and sessions that have stopped moving.", schedule("*/15 * * * *")),
            ],
        },
    ]
}

/// A template by its id, or by its title in any letter case (`--role "QA engineer"`).
pub fn find(role: &str) -> Option<RoleTemplate> {
    let wanted = role.trim();
    all().into_iter().find(|template| template.id == wanted || template.title.eq_ignore_ascii_case(wanted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_eight_roles_are_bundled_each_with_its_text_skills_and_duties() {
        let templates = all();
        let ids: Vec<&str> = templates.iter().map(|template| template.id).collect();
        assert_eq!(ids, ["cto", "chief-of-staff", "ux-designer", "qa-engineer", "release-manager", "docs-writer", "security-auditor", "watcher"]);
        let titles: Vec<&str> = templates.iter().map(|template| template.title).collect();
        assert_eq!(titles, ["CTO", "Chief of staff", "UX designer", "QA engineer", "Release manager", "Docs writer", "Security auditor", "Watcher"]);
        for template in &templates {
            assert!(!template.description.is_empty() && !template.description.contains('\n'), "{}", template.id);
            assert!(template.role.trim().len() > 200, "{}", template.id);
            assert!(!template.skills.is_empty() && !template.duties.is_empty(), "{}", template.id);
            let mut duty_ids: Vec<&str> = template.duties.iter().map(|duty| duty.id).collect();
            duty_ids.sort_unstable();
            duty_ids.dedup();
            assert_eq!(duty_ids.len(), template.duties.len(), "{}", template.id);
        }
    }

    #[test]
    fn a_template_carries_no_credentials_or_permissions_and_every_duty_is_off() {
        for template in all() {
            assert!(template.duties.iter().all(|duty| !duty.enabled), "{}", template.id);
            let value = serde_json::to_value(&template).unwrap();
            let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["description", "duties", "id", "role", "skills", "title"], "{}", template.id);
            for duty in value["duties"].as_array().unwrap() {
                let mut keys: Vec<&str> = duty.as_object().unwrap().keys().map(String::as_str).collect();
                keys.sort_unstable();
                assert_eq!(keys, ["description", "enabled", "id", "title", "wake"], "{}", template.id);
                assert_eq!(duty["enabled"], false);
            }
        }
        assert_eq!(serde_json::to_value(schedule("0 9 * * 1-5")).unwrap(), serde_json::json!({"kind": "schedule", "cron": "0 9 * * 1-5"}));
        assert_eq!(serde_json::to_value(DutyWake::Bot).unwrap(), serde_json::json!({"kind": "bot"}));
    }

    #[test]
    fn a_role_is_found_by_id_or_by_title() {
        assert_eq!(find("cto").unwrap().title, "CTO");
        assert_eq!(find(" QA Engineer ").unwrap().id, "qa-engineer");
        assert_eq!(find("chief of staff").unwrap().id, "chief-of-staff");
        assert!(find("janitor").is_none());
    }
}
