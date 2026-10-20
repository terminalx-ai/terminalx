//! A GitHub repository's Markdown issue templates
//! (`.github/ISSUE_TEMPLATE/*.md`), read from the project's checkout. The
//! new-issue form offers them and fills the description from the chosen one,
//! as the website's "New issue" does. YAML issue forms (`*.yml`) are not
//! Markdown and are left out.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

/// Templates bigger than this are not read: a template is a page of prompts, not a document.
const MAX_TEMPLATE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplate {
    /// The file's name, which tells templates apart.
    pub file: String,
    /// The front matter's `name`, or the file's name without `.md`.
    pub name: String,
    pub about: Option<String>,
    /// The title the issue starts with.
    pub title: Option<String>,
    /// Label names, as the repository spells them.
    pub labels: Vec<String>,
    /// GitHub logins.
    pub assignees: Vec<String>,
    /// The Markdown under the front matter.
    pub body: String,
}

/// The templates in `<project>/.github/ISSUE_TEMPLATE`, by file name. None
/// when there is no such folder, or no checkout on this computer.
pub fn list(project: &Path) -> Vec<IssueTemplate> {
    // A cloud project (`cloud:<orgId>:…`) is named by its key, not a path: read
    // as one, it would be a folder under whatever directory the app runs in.
    if !project.is_absolute() {
        return Vec::new();
    }
    let github = project.join(".github");
    let folder = github.join("ISSUE_TEMPLATE");
    // Only the checkout's own folder: one linked from elsewhere could be anything on disk.
    // (A linked template file is skipped below: an entry's metadata does not follow the link.)
    if [&github, &folder].iter().any(|path| std::fs::symlink_metadata(path).map_or(true, |meta| !meta.is_dir())) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&folder) else { return Vec::new() };
    let mut templates: Vec<IssueTemplate> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")))
        .filter(|entry| entry.metadata().is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_TEMPLATE_BYTES))
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(entry.path()).ok()?;
            Some(parse(&file, &text))
        })
        .collect();
    templates.sort_by(|a, b| a.file.cmp(&b.file));
    templates
}

/// One template file. Front matter that is not YAML is left as it is in the body.
pub fn parse(file: &str, text: &str) -> IssueTemplate {
    let stem = file.rsplit_once('.').map_or(file, |(stem, _)| stem);
    let mut template = IssueTemplate {
        file: file.into(),
        name: stem.into(),
        about: None,
        title: None,
        labels: Vec::new(),
        assignees: Vec::new(),
        body: text.into(),
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else { return template };
    let Some((front, body)) = split_front(rest) else { return template };
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(front) else { return template };
    let text_of = |key: &str| map.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    if let Some(name) = text_of("name") {
        template.name = name;
    }
    template.about = text_of("about");
    // A title is often a prefix to type after ("[Bug] "), so its spaces stay.
    template.title = map.get("title").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(String::from);
    template.labels = names(map.get("labels"));
    template.assignees = names(map.get("assignees"));
    template.body = body.trim_start_matches(['\r', '\n']).into();
    template
}

/// The front matter and the body after its closing `---` line.
fn split_front(rest: &str) -> Option<(&str, &str)> {
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some((&rest[..at], &rest[at + line.len()..]));
        }
        at += line.len();
    }
    None
}

/// `labels: bug, help wanted` or `labels: [bug, "help wanted"]`.
fn names(value: Option<&Value>) -> Vec<String> {
    let each: Vec<String> = match value {
        Some(Value::String(text)) => text.split(',').map(String::from).collect(),
        Some(Value::Sequence(items)) => items.iter().filter_map(Value::as_str).map(String::from).collect(),
        _ => Vec::new(),
    };
    each.into_iter().map(|name| name.trim().to_string()).filter(|name| !name.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_front_matter_and_the_body() {
        let template = parse("bug_report.md", "---\nname: Bug report\nabout: Something broke\ntitle: \"[Bug] \"\nlabels: bug, help wanted\nassignees:\n  - octocat\n---\n\n**What happened**\n");
        assert_eq!(template.name, "Bug report");
        assert_eq!(template.about.as_deref(), Some("Something broke"));
        assert_eq!(template.title.as_deref(), Some("[Bug] "));
        assert_eq!(template.labels, vec!["bug", "help wanted"]);
        assert_eq!(template.assignees, vec!["octocat"]);
        assert_eq!(template.body, "**What happened**\n");
    }

    #[test]
    fn a_file_without_front_matter_is_all_body() {
        let template = parse("plain.md", "Just text\n---\nmore\n");
        assert_eq!(template.name, "plain");
        assert_eq!(template.body, "Just text\n---\nmore\n");
        assert!(template.labels.is_empty());
    }

    #[test]
    fn front_matter_that_never_closes_is_left_in_the_body() {
        let template = parse("broken.md", "---\nname: x\nbody\n");
        assert_eq!(template.name, "broken");
        assert_eq!(template.body, "---\nname: x\nbody\n");
    }

    #[test]
    fn label_lists_and_crlf_files_are_read() {
        let template = parse("f.md", "---\r\nname: Feature\r\nlabels: [enhancement, \"needs triage\"]\r\n---\r\nBody\r\n");
        assert_eq!(template.name, "Feature");
        assert_eq!(template.labels, vec!["enhancement", "needs triage"]);
        assert_eq!(template.body, "Body\r\n");
    }

    #[test]
    fn lists_only_markdown_templates_in_file_order() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join(".github").join("ISSUE_TEMPLATE");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("feature_request.md"), "---\nname: Feature request\n---\nWhat?\n").unwrap();
        std::fs::write(folder.join("bug_report.md"), "---\nname: Bug report\nlabels: bug\n---\nSteps\n").unwrap();
        std::fs::write(folder.join("config.yml"), "blank_issues_enabled: true\n").unwrap();
        std::fs::write(folder.join("form.yml"), "name: Form\nbody: []\n").unwrap();
        let names: Vec<String> = list(dir.path()).into_iter().map(|template| template.name).collect();
        assert_eq!(names, vec!["Bug report", "Feature request"]);
    }

    #[cfg(unix)]
    #[test]
    fn follows_no_link_out_of_the_checkout() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "---\nname: Elsewhere\n---\nNot the repo's\n").unwrap();
        let linked_folder = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(linked_folder.path().join(".github")).unwrap();
        std::os::unix::fs::symlink(outside.path(), linked_folder.path().join(".github").join("ISSUE_TEMPLATE")).unwrap();
        assert!(list(linked_folder.path()).is_empty());

        let linked_github = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("ISSUE_TEMPLATE")).unwrap();
        std::fs::write(outside.path().join("ISSUE_TEMPLATE").join("bug.md"), "Steps\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), linked_github.path().join(".github")).unwrap();
        assert!(list(linked_github.path()).is_empty());

        let linked_file = tempfile::tempdir().unwrap();
        let folder = linked_file.path().join(".github").join("ISSUE_TEMPLATE");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("bug.md"), "Steps\n").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.md"), folder.join("secret.md")).unwrap();
        let names: Vec<String> = list(linked_file.path()).into_iter().map(|template| template.name).collect();
        assert_eq!(names, vec!["bug"]);
    }

    #[test]
    fn no_folder_is_no_templates() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list(dir.path()).is_empty());
    }

    #[test]
    fn a_project_with_no_checkout_here_has_none() {
        // Tests run in the crate's folder, so `..` is this repository, which has two templates: a
        // relative name is never read against the working directory, a cloud project's key included.
        assert!(list(Path::new("..")).is_empty());
        assert!(list(Path::new("cloud:org_01H:github.com/acme/widgets")).is_empty());
    }

    #[test]
    fn this_repository_offers_its_two_templates() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let templates = list(root);
        let names: Vec<&str> = templates.iter().map(|template| template.name.as_str()).collect();
        assert_eq!(names, vec!["Bug report", "Feature request"]);
        assert_eq!(templates[0].labels, vec!["bug"]);
        assert!(templates[0].body.starts_with("**What happened"));
    }

    /// Live, opt-in (`TERMINALX_LIVE_ISSUE_SANDBOX=1 cargo test live_new_issue -- --ignored --nocapture`):
    /// what the new-issue form sends, against the real `gh` login and Linear
    /// key. One issue per provider, titled "[TerminalX test] …", with only the
    /// reader assigned and labels that already exist; each is read back and
    /// then closed as not planned (GitHub) or cancelled (Linear) at once.
    #[test]
    #[ignore]
    fn live_new_issue_on_each_provider() {
        use crate::issue_ops::{create, details, options, set_state, viewer::viewer, IssueCreate, Provider, StateChange, CloseReason, Target};
        if std::env::var("TERMINALX_LIVE_ISSUE_SANDBOX").as_deref() != Ok("1") {
            return;
        }
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let bug = list(&repo).into_iter().find(|template| template.file == "bug_report.md").unwrap();
        for provider in [Provider::Github, Provider::Linear] {
            let target = Target::resolve(&repo, provider).unwrap();
            let me = viewer(&target).unwrap();
            let input = match provider {
                Provider::Github => {
                    let offered = options(&target, None, None, true).unwrap();
                    assert!(bug.labels.iter().all(|name| offered.labels.iter().any(|label| &label.id == name)), "the template's labels exist");
                    IssueCreate {
                        title: "[TerminalX test] new issue from the bug template — ignore".into(),
                        description: bug.body.clone(),
                        assignees: vec![me.id.clone()],
                        labels: bug.labels.clone(),
                        ..Default::default()
                    }
                }
                Provider::Linear => {
                    // The sandbox's own team.
                    let team = details(&target, "PRO-101").unwrap().issue.team.unwrap();
                    let offered = options(&target, None, Some(&team.id), true).unwrap();
                    let label = offered.labels.iter().find(|label| !label.is_group && label.group.is_none()).unwrap();
                    let backlog = offered.states.iter().find(|state| state.state_type == "backlog").unwrap();
                    IssueCreate {
                        team_id: Some(team.id.clone()),
                        title: "[TerminalX test] new issue with every field — ignore".into(),
                        // Plain paragraphs: Linear rewrites list bullets ("- " becomes "* ").
                        description: "Made by the new-issue form's live check.\n\nWith **bold** text.".into(),
                        assignees: vec![me.id.clone()],
                        labels: vec![label.id.clone()],
                        state_id: Some(backlog.id.clone()),
                        priority: Some(4),
                    }
                }
            };
            let made = create(&target, &input).unwrap();
            let id = made.issue.id.clone();
            // Read again separately from the create's own answer.
            let read = details(&target, &id).unwrap();
            println!("{provider:?} created {} {}", read.issue.identifier, read.issue.url);
            // Closed before anything is checked, so a failed check leaves nothing open.
            let change = match provider {
                Provider::Github => StateChange::Close { reason: CloseReason::NotPlanned },
                Provider::Linear => {
                    let team = read.issue.team.as_ref().unwrap();
                    let offered = options(&target, None, Some(&team.id), false).unwrap();
                    StateChange::WorkflowState { state_id: offered.states.iter().find(|state| state.state_type == "canceled").unwrap().id.clone() }
                }
            };
            let closed = set_state(&target, &id, &change).unwrap();
            println!("{provider:?} {} closed: {}", closed.issue.identifier, closed.issue.state);
            assert_eq!(read.issue.title, input.title);
            assert_eq!(read.description.trim(), input.description.trim());
            assert_eq!(read.issue.assignees.iter().map(|user| user.id.clone()).collect::<Vec<_>>(), input.assignees);
            let mut labels: Vec<String> = read.issue.labels.iter().map(|label| label.id.clone().unwrap_or_else(|| label.name.clone())).collect();
            labels.sort();
            assert_eq!(labels, input.labels);
            if provider == Provider::Linear {
                assert_eq!(read.state_id, input.state_id);
                assert_eq!(read.priority, Some(4));
            }
            println!("{provider:?} read back: title, description, assignee (reader), {} label(s){} as sent", labels.len(), if provider == Provider::Linear { ", state Backlog, priority Low" } else { "" });
        }
    }
}
