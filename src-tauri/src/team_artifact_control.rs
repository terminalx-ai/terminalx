//! `terminalx artifact publish` and `show` (PRO-158): what an agent may put
//! in front of everyone in an organization, decided here in native code
//! before the window hears of it.
//!
//! - **Its own switch.** "Let agents publish team artifacts" is off until the
//!   person turns it on; the cloud-workspace switch does not cover it.
//! - **Only a file of the session's own.** The file is read here, not by the
//!   command line: it must resolve (symlinks included) inside the calling
//!   session's working directory, with no hidden part in its path and not a
//!   name that holds secrets. Whatever the caller says it is, it can publish
//!   only what lies in that session's folder.
//! - **A slug in use is never reused by default.** Adding a version to an
//!   existing artifact needs `--new-version`, and the window refuses it for
//!   anyone but its author and admins.
//! - **The tab's mode decides whether the person is asked.** A tab that asks
//!   first shows an approval card naming the file, the organization and
//!   that every member will see it; a tab that runs without asking
//!   (`bypassPermissions`) does not ask.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::cloud_control::Answer;
use crate::control::ControlError;
use crate::issue_control::{Ask, Question};
use crate::sink::EventSink;

const SETTING_FILE: &str = "team-artifacts-publish.json";

/// The mode of a tab that runs without asking.
const RUNS_WITHOUT_ASKING: &str = "bypassPermissions";

fn setting_path() -> Option<PathBuf> {
    crate::store::root().ok().map(|root| root.join(SETTING_FILE))
}

fn enabled_at(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Whether agents may publish team artifacts. Off unless the file says on.
pub fn enabled() -> bool {
    if crate::data_privacy::enabled() { return false; }
    setting_path().is_some_and(|path| enabled_at(&path))
}

/// Store the switch. Turning it on is the caller's to confirm with the person first.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = setting_path().ok_or_else(|| "team_artifacts_setting_unwritable".to_string())?;
    if let Some(dir) = path.parent() {
        crate::store::ensure_dir(dir.to_path_buf()).map_err(|_| "team_artifacts_setting_unwritable".to_string())?;
    }
    crate::store::write_atomic(&path, json!({ "enabled": enabled }).to_string().as_bytes()).map_err(|_| "team_artifacts_setting_unwritable".to_string())
}

pub fn disabled_error() -> ControlError {
    ControlError::new(
        "artifacts_publish_disabled",
        "Agents cannot publish team artifacts until that is turned on in TerminalX.",
        Some("Ask the person to turn on \"Let agents publish team artifacts\" in Settings > General. Do not try another way to publish it.".to_string()),
    )
}

fn refused(code: &str, message: impl Into<String>) -> ControlError {
    ControlError::new(code, message, Some("Publish a Markdown, HTML or text file of this session's own, or ask the person to publish it from the overview.".to_string()))
}

/// File names that hold keys, tokens or passwords, whatever their extension.
fn secret_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let stem = name.split('.').next().unwrap_or_default();
    ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].iter().any(|key| stem.starts_with(key))
        || ["secret", "credential", "password", "passwd", "private-key", "private_key", "privatekey", "api-key", "api_key", "apikey", "token"].iter().any(|word| stem.contains(word))
        || [".env", ".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx", ".npmrc", ".netrc", ".pgpass"].iter().any(|ending| name.ends_with(ending) || name.contains(&format!("{ending}.")))
}

/// The file the session may publish: `path`, resolved, inside `cwd`, resolved.
pub(crate) fn publishable_file(cwd: &Path, path: &Path) -> Result<PathBuf, ControlError> {
    let folder = crate::paths::canonicalize(cwd).map_err(|_| refused("artifact_path_refused", "The session's folder could not be found, so nothing in it can be published."))?;
    let file = crate::paths::canonicalize(path).map_err(|_| ControlError::invalid(format!("Could not find {}.", path.display())))?;
    let Ok(inside) = file.strip_prefix(&folder) else {
        return Err(refused("artifact_path_outside", "Only a file inside this session's folder can be published. Links that lead out of it are followed and refused."));
    };
    if inside.as_os_str().is_empty() || !file.is_file() {
        return Err(ControlError::invalid("Publish a file, not a folder."));
    }
    for part in inside.components() {
        let Component::Normal(part) = part else { return Err(refused("artifact_path_outside", "Only a file inside this session's folder can be published.")) };
        let part = part.to_string_lossy();
        if part.starts_with('.') {
            return Err(refused("artifact_path_refused", "Hidden files and folders (a name starting with a dot, such as .env or .git) are never published."));
        }
    }
    let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    if secret_name(&name) {
        return Err(refused("artifact_path_refused", format!("{name} looks like it holds keys, tokens or passwords, so it is never published.")));
    }
    Ok(file)
}

fn content_type(path: &Path) -> Result<&'static str, ControlError> {
    match path.extension().map(|extension| extension.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("md" | "markdown") => Ok("text/markdown"),
        Some("html" | "htm") => Ok("text/html"),
        Some("txt" | "text") => Ok("text/plain"),
        _ => Err(ControlError::invalid("Publish a Markdown (.md), HTML (.html) or text (.txt) file.")),
    }
}

fn read_text(path: &Path) -> Result<String, ControlError> {
    use std::io::Read;
    let limit = crate::cloud_workspaces::TEAM_ARTIFACT_CONTENT_BYTES;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut bytes))
        .map_err(|error| ControlError::invalid(format!("Could not read {}: {error}", path.display())))?;
    if bytes.len() > limit {
        return Err(ControlError::new("team_artifact_too_large", "The file is larger than 1 MB, the most one artifact may hold.", None::<String>));
    }
    String::from_utf8(bytes).map_err(|_| ControlError::invalid("The file is not text."))
}

fn text(params: &Value, name: &str) -> Option<String> {
    params.get(name).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

/// Everything before the window publishes: the file, and the session it belongs to.
struct Request {
    file: PathBuf,
    shown: String,
    content_type: &'static str,
    content: String,
    session: crate::store::index::SessionEntry,
    asks_first: bool,
}

fn request(params: &Value) -> Result<Request, ControlError> {
    let caller = params.get("caller");
    let session_id = caller.and_then(|caller| caller.get("session")).and_then(Value::as_str).filter(|id| !id.is_empty());
    let Some(session_id) = session_id else {
        return Err(ControlError::new("artifact_needs_session", "Publish from a terminal in a TerminalX session: the file must be one of that session's own.", None::<String>));
    };
    let session = crate::store::index::load()
        .map_err(ControlError::internal)?
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| ControlError::new("artifact_needs_session", "The session this command says it runs in is not one of this Mac's.", None::<String>))?;
    let path = text(params, "path").ok_or_else(|| ControlError::invalid("Name the file to publish."))?;
    let file = publishable_file(Path::new(&session.cwd), Path::new(&path))?;
    let content_type = content_type(&file)?;
    let content = read_text(&file)?;
    let shown = crate::paths::canonicalize(Path::new(&session.cwd))
        .ok()
        .and_then(|folder| file.strip_prefix(folder).ok().map(|inside| inside.to_string_lossy().into_owned()))
        .unwrap_or_else(|| file.to_string_lossy().into_owned());
    // The tab named by the caller; without one, or one it does not hold, the person is asked.
    let tab = caller.and_then(|caller| caller.get("tab")).and_then(Value::as_str).and_then(|tab| session.tab(tab));
    let asks_first = tab.is_none_or(|tab| tab.permission_mode != RUNS_WITHOUT_ASKING);
    Ok(Request { file, shown, content_type, content, session, asks_first })
}

fn answer_refusal(answer: Answer, org: &str) -> Result<(), ControlError> {
    let stop = "Do not retry it. Tell the person what you wanted to publish and why, and let them decide.".to_string();
    let (code, message, recovery) = match answer {
        Answer::Accepted => return Ok(()),
        Answer::Declined => ("declined", format!("The person refused to publish it to {org}. Nothing was published."), stop),
        Answer::Expired => ("expired", "The person did not answer in time. Nothing was published.".to_string(), stop),
        Answer::Busy => ("busy", "Another question is waiting for the person. Nothing was published.".to_string(), "Wait for the person to answer it, then try once more.".to_string()),
        Answer::Backoff(seconds) => ("backoff", format!("The person refused or left a question unanswered a moment ago; no new question is shown for {seconds} s. Nothing was published."), stop),
    };
    Err(ControlError::new(code, message, Some(recovery)))
}

/// `artifacts.publish`: read the session's file, settle the organization and
/// the slug with the window, ask when the tab asks first, then publish.
pub fn publish(sink: &dyn EventSink, ask: Option<&Ask>, params: Value) -> Result<Value, ControlError> {
    if !enabled() { return Err(disabled_error()); }
    let request = request(&params)?;
    let title = text(&params, "title").unwrap_or_else(|| request.file.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default());
    let new_version = params.get("newVersion").and_then(Value::as_bool).unwrap_or(false);
    let plan = crate::cloud_control::call(sink, "artifacts.plan", json!({
        "org": params.get("org"), "slug": params.get("slug"), "template": params.get("template"), "newVersion": new_version,
    }))?;
    let org_id = plan.get("orgId").and_then(Value::as_str).ok_or_else(|| ControlError::internal("The window named no organization."))?.to_string();
    let org_name = plan.get("orgName").and_then(Value::as_str).unwrap_or("the organization").to_string();
    if request.asks_first {
        let ask = ask.ok_or_else(|| ControlError::new("confirmation_unavailable", "Publishing needs the person's answer, and there is no TerminalX window to ask in. Nothing was published.", None::<String>))?;
        let adds = plan.get("adds").and_then(Value::as_str);
        let answer = ask(Question {
            session_id: Some(request.session.id.clone()),
            session_title: Some(request.session.title.chars().take(80).collect()),
            project: request.session.project_path.clone(),
            target: request.shown.clone(),
            summary: match adds {
                Some(slug) => format!("Publish {} as a new version of @{slug} to {org_name}, visible to every member.", request.shown),
                None => format!("Publish {} to {org_name}, visible to every member.", request.shown),
            },
            description: None,
            title: format!("Publish to everyone at {org_name}?"),
            message: format!("A terminalx command asks to publish {} as \u{201c}{title}\u{201d}.", request.shown),
            agree: "Publish".into(),
            notice: Some(format!("Every member of {org_name} can open it from the overview. Cancel if you did not ask for this.")),
        });
        answer_refusal(answer, &org_name)?;
    }
    crate::cloud_control::call(sink, "artifacts.publish", json!({
        "orgId": org_id, "title": title, "contentType": request.content_type, "content": request.content,
        "slug": params.get("slug"), "template": params.get("template"), "newVersion": new_version,
        "note": params.get("note"), "source": request.session.title,
    }))
}

/// `artifacts.show`: a template's text, for an agent to fill in.
pub fn show(sink: &dyn EventSink, params: Value) -> Result<Value, ControlError> {
    if !enabled() { return Err(disabled_error()); }
    crate::cloud_control::call(sink, "artifacts.show", params)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("work");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/plan.md"), "# Plan").unwrap();
        (dir, root)
    }

    fn code(result: Result<PathBuf, ControlError>) -> String {
        result.unwrap_err().code
    }

    #[test]
    fn a_file_of_the_sessions_own_is_publishable() {
        let (_dir, root) = folder();
        let file = publishable_file(&root, &root.join("docs/plan.md")).unwrap();
        assert!(file.ends_with("docs/plan.md"));
    }

    #[test]
    fn a_file_outside_the_session_folder_is_refused() {
        let (dir, root) = folder();
        std::fs::write(dir.path().join("elsewhere.md"), "x").unwrap();
        assert_eq!(code(publishable_file(&root, &dir.path().join("elsewhere.md"))), "artifact_path_outside");
        assert_eq!(code(publishable_file(&root, &root.join("../elsewhere.md"))), "artifact_path_outside");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_that_leads_out_of_the_folder_is_followed_and_refused() {
        let (dir, root) = folder();
        std::fs::write(dir.path().join("notes.md"), "private").unwrap();
        std::os::unix::fs::symlink(dir.path().join("notes.md"), root.join("docs/link.md")).unwrap();
        assert_eq!(code(publishable_file(&root, &root.join("docs/link.md"))), "artifact_path_outside");
        // A link inside the folder to a file inside it is that file.
        std::os::unix::fs::symlink(root.join("docs/plan.md"), root.join("same.md")).unwrap();
        assert!(publishable_file(&root, &root.join("same.md")).is_ok());
    }

    #[test]
    fn hidden_files_and_folders_are_refused() {
        let (_dir, root) = folder();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/notes.md"), "x").unwrap();
        std::fs::write(root.join(".env"), "KEY=1").unwrap();
        std::fs::write(root.join(".notes.md"), "x").unwrap();
        for path in [".git/notes.md", ".env", ".notes.md"] {
            assert_eq!(code(publishable_file(&root, &root.join(path))), "artifact_path_refused", "{path}");
        }
    }

    #[test]
    fn files_named_for_secrets_are_refused() {
        let (_dir, root) = folder();
        for name in ["id_rsa.txt", "prod.env.md", "aws-credentials.md", "secrets.md", "server.key.txt", "api-token.txt", "passwords.html"] {
            std::fs::write(root.join(name), "x").unwrap();
            assert_eq!(code(publishable_file(&root, &root.join(name))), "artifact_path_refused", "{name}");
        }
        assert!(!secret_name("release-notes.md"));
        assert!(!secret_name("migration-plan.html"));
    }

    #[test]
    fn a_folder_or_a_missing_file_is_not_publishable() {
        let (_dir, root) = folder();
        assert_eq!(code(publishable_file(&root, &root.join("docs"))), "invalid_arguments");
        assert_eq!(code(publishable_file(&root, &root.join("missing.md"))), "invalid_arguments");
    }

    #[test]
    fn only_markdown_html_and_text_are_published_and_at_most_one_megabyte() {
        assert_eq!(content_type(Path::new("a.md")).unwrap(), "text/markdown");
        assert_eq!(content_type(Path::new("a.HTML")).unwrap(), "text/html");
        assert!(content_type(Path::new("a.pdf")).is_err());
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.md");
        std::fs::write(&big, vec![b'a'; crate::cloud_workspaces::TEAM_ARTIFACT_CONTENT_BYTES + 1]).unwrap();
        assert_eq!(read_text(&big).unwrap_err().code, "team_artifact_too_large");
        let binary = dir.path().join("binary.txt");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read_text(&binary).unwrap_err().code, "invalid_arguments");
    }

    #[test]
    fn the_switch_is_off_until_the_file_says_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SETTING_FILE);
        assert!(!enabled_at(&path));
        std::fs::write(&path, r#"{"enabled":true}"#).unwrap();
        assert!(enabled_at(&path));
        std::fs::write(&path, "not json").unwrap();
        assert!(!enabled_at(&path));
    }

    #[test]
    fn refusals_say_nothing_was_published() {
        for answer in [Answer::Declined, Answer::Expired, Answer::Busy, Answer::Backoff(60)] {
            let error = answer_refusal(answer, "Northwind").unwrap_err();
            assert!(error.message.contains("Nothing was published"), "{}", error.message);
        }
        assert!(answer_refusal(Answer::Accepted, "Northwind").is_ok());
    }
}
