//! Parsing, conversion and writes on recorded files (`agent_configs_fixtures`):
//! a `~/.claude.json` as Claude Code keeps it, with far more than servers in
//! it, and a commented `~/.codex/config.toml`.

use super::*;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/agent_configs_fixtures");

struct Rig {
    _dir: tempfile::TempDir,
    homes: Homes,
}

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let fixtures = Path::new(FIXTURES);
    fs::copy(fixtures.join("claude.json"), home.join(".claude.json")).unwrap();
    copy_tree(&fixtures.join("claude"), &home.join(".claude"));
    copy_tree(&fixtures.join("codex"), &home.join(".codex"));
    fs::copy(fixtures.join("config.toml"), home.join(".codex/config.toml")).unwrap();
    let homes = Homes {
        claude_json: home.join(".claude.json"),
        claude_dir: home.join(".claude"),
        codex_dir: home.join(".codex"),
        backups: home.join("terminalx/backups"),
        home,
    };
    Rig { _dir: dir, homes }
}

fn change(kind: Kind, name: &str, direction: Direction) -> Change {
    Change { kind, name: name.into(), direction }
}

fn item<'a>(c: &'a Comparison, kind: Kind, name: &str) -> &'a Item {
    c.items.iter().find(|i| i.kind == kind && i.name == name).unwrap_or_else(|| panic!("no {kind:?} {name}"))
}

/// Every file under `dir`, with its bytes, to show nothing was touched.
fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            // A link is recorded as where it points, so a dangling one shows too.
            if let Ok(to) = fs::read_link(&path) {
                out.insert(path.clone(), format!("-> {}", to.display()).into_bytes());
            } else if path.is_dir() {
                walk(&path, out);
            } else {
                out.insert(path.clone(), fs::read(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, &mut out);
    out
}

fn apply_now(homes: &Homes, changes: &[Change]) -> Vec<Written> {
    let preview = preview_in(homes, changes).unwrap();
    apply_in(homes, changes, &preview.token).unwrap()
}

#[test]
fn the_recorded_homes_compare_item_by_item() {
    let rig = rig();
    let c = compare_in(&rig.homes).unwrap();
    assert!(c.problems.is_empty(), "{:?}", c.problems);
    let statuses: Vec<_> = c.items.iter().map(|i| (i.kind, i.name.as_str(), i.status)).collect();
    use Kind::*;
    use Status::*;
    assert_eq!(
        statuses,
        vec![
            (Mcp, "legacy-events", OnlyClaude),
            (Mcp, "linear", OnlyClaude),
            (Mcp, "playwright", OnlyClaude),
            (Mcp, "sentry", Different),
            (Mcp, "context7", OnlyCodex),
            (Mcp, "github", Same),
            (Command, "review", OnlyClaude),
            (Command, "draftpr", OnlyCodex),
            (Command, "changelog", Same),
            (Skill, "release-notes", OnlyClaude),
            (Skill, "pdf-tools", Different),
        ]
    );
    assert_eq!(item(&c, Mcp, "playwright").claude_summary.as_deref(), Some("npx @playwright/mcp@latest"));
    assert_eq!(item(&c, Mcp, "context7").codex_summary.as_deref(), Some("npx -y @upstash/context7-mcp"));
    assert_eq!(item(&c, Mcp, "legacy-events").to_codex_blocked.as_deref(), Some("Codex has no SSE transport; it takes stdio and streamable HTTP servers"));
    assert_eq!(item(&c, Mcp, "linear").to_codex_blocked, None);
    assert_eq!(item(&c, Command, "review").claude_summary.as_deref(), Some("Review the current branch against main"));
    assert_eq!(c.claude_file, "~/.claude.json");
    assert_eq!(c.codex_file, "~/.codex/config.toml");
}

#[test]
fn claude_servers_convert_to_codex_shapes() {
    let codex = |json: &str| {
        let server = parse_claude_server(&serde_json::from_str(json).unwrap());
        codex_table(&server.transport.unwrap()).map(|t| t.to_string())
    };
    assert_eq!(codex(r#"{"type":"stdio","command":"npx","args":["@playwright/mcp@latest"],"env":{}}"#).unwrap(), "command = \"npx\"\nargs = [\"@playwright/mcp@latest\"]\n");
    assert_eq!(codex(r#"{"command":"gh","args":["mcp-server"],"env":{"GITHUB_TOKEN":"${GITHUB_TOKEN}","LOG":"debug"}}"#).unwrap(), "command = \"gh\"\nargs = [\"mcp-server\"]\nenv = { LOG = \"debug\" }\nenv_vars = [\"GITHUB_TOKEN\"]\n");
    assert_eq!(
        codex(r#"{"type":"http","url":"https://x/mcp","headers":{"Authorization":"Bearer ${TOKEN}","X-Team":"${TEAM_ID}","X-Client":"terminal"}}"#).unwrap(),
        "url = \"https://x/mcp\"\nbearer_token_env_var = \"TOKEN\"\nhttp_headers = { X-Client = \"terminal\" }\nenv_http_headers = { X-Team = \"TEAM_ID\" }\n"
    );
    assert!(codex(r#"{"command":"x","env":{"API_KEY":"${OTHER}"}}"#).unwrap_err().contains("passes a variable only under its own name"));
    let ws = parse_claude_server(&serde_json::from_str(r#"{"type":"ws","url":"wss://x"}"#).unwrap());
    assert!(ws.transport.unwrap_err().contains("`ws` transport"));
    let oauth = parse_claude_server(&serde_json::from_str(r#"{"type":"http","url":"https://x","oauth":{"clientId":"a"}}"#).unwrap());
    assert_eq!(oauth.stays, vec!["`oauth` stays in Claude Code only"]);
}

#[test]
fn codex_servers_convert_to_claude_shapes() {
    let claude = |toml_text: &str| {
        let server = parse_codex_server(&toml::from_str::<toml::Value>(toml_text).unwrap());
        (claude_entry(&server.transport.unwrap(), 0, &[]), server.stays)
    };
    let (entry, stays) = claude("command = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\nstartup_timeout_sec = 20\nenv_vars = [\"CONTEXT7_KEY\"]\n");
    assert_eq!(entry, "{\n  \"type\": \"stdio\",\n  \"command\": \"npx\",\n  \"args\": [\n    \"-y\",\n    \"@upstash/context7-mcp\"\n  ],\n  \"env\": {\n    \"CONTEXT7_KEY\": \"${CONTEXT7_KEY}\"\n  }\n}");
    assert_eq!(stays, vec!["`startup_timeout_sec` stays in Codex only"]);
    let (entry, _) = claude("url = \"https://x/mcp\"\nbearer_token_env_var = \"T\"\nenv_http_headers = { X-Team = \"TEAM\" }\n");
    assert_eq!(entry, "{\n  \"type\": \"http\",\n  \"url\": \"https://x/mcp\",\n  \"headers\": {\n    \"Authorization\": \"Bearer ${T}\",\n    \"X-Team\": \"${TEAM}\"\n  }\n}");
    let (_, stays) = claude("command = \"x\"\nenabled = false\n");
    assert_eq!(stays, vec!["turned off in Codex (`enabled = false`); Claude Code starts it"]);
}

#[test]
fn a_claude_only_server_lands_in_codex_with_the_rest_of_the_file_untouched() {
    let rig = rig();
    let before = fs::read_to_string(rig.homes.codex_toml()).unwrap();
    let changes = [change(Kind::Mcp, "linear", Direction::ToCodex), change(Kind::Mcp, "playwright", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    assert_eq!(preview.files.len(), 1);
    assert_eq!(preview.files[0].path, "~/.codex/config.toml");
    assert_eq!(preview.files[0].backup.as_deref(), Some(format!("~/.codex/config.toml.bak-{}", today()).as_str()));
    assert_eq!(preview.files[0].text, "[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n\n[mcp_servers.playwright]\ncommand = \"npx\"\nargs = [\"@playwright/mcp@latest\"]\n");
    assert_eq!(preview.added.mcp, 2);
    assert_eq!(preview.replaced.mcp, 0);

    let written = apply_in(&rig.homes, &changes, &preview.token).unwrap();
    assert_eq!(written.len(), 1);
    let after = fs::read_to_string(rig.homes.codex_toml()).unwrap();
    // The reader's file is kept byte for byte; the servers go after its last server.
    assert_eq!(after, before.replacen("\n[projects.", &format!("\n{}\n[projects.", preview.files[0].text), 1));
    let backup = rig.homes.codex_dir.join(format!("config.toml.bak-{}", today()));
    assert_eq!(fs::read_to_string(backup).unwrap(), before);
    // Codex now has it, and the comparison says so.
    let c = compare_in(&rig.homes).unwrap();
    assert_eq!(item(&c, Kind::Mcp, "linear").status, Status::Same);
    assert_eq!(item(&c, Kind::Mcp, "playwright").status, Status::Same);
    // What Codex's own parser reads.
    let parsed: toml::Table = toml::from_str(&after).unwrap();
    assert_eq!(parsed["mcp_servers"]["playwright"]["args"].as_array().unwrap()[0].as_str(), Some("@playwright/mcp@latest"));
    assert_eq!(parsed["projects"]["/Users/example/code/app"]["trust_level"].as_str(), Some("trusted"));
}

#[test]
fn using_claudes_version_replaces_codexs_in_place_with_its_comment() {
    let rig = rig();
    apply_now(&rig.homes, &[change(Kind::Mcp, "sentry", Direction::ToCodex)]);
    let after = fs::read_to_string(rig.homes.codex_toml()).unwrap();
    assert!(after.contains("# Sentry, the self-hosted one\n[mcp_servers.sentry]\nurl = \"https://mcp.sentry.dev/mcp\"\nbearer_token_env_var = \"SENTRY_TOKEN\"\n\n[mcp_servers.context7]"), "{after}");
    assert!(!after.contains("sentry.internal"));
    assert_eq!(item(&compare_in(&rig.homes).unwrap(), Kind::Mcp, "sentry").status, Status::Same);
}

#[test]
fn a_codex_only_server_lands_in_claude_json_keeping_every_other_key() {
    let rig = rig();
    let before = fs::read_to_string(&rig.homes.claude_json).unwrap();
    let changes = [change(Kind::Mcp, "context7", Direction::ToClaude)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    assert_eq!(preview.files[0].path, "~/.claude.json");
    assert_eq!(
        preview.files[0].text,
        "\"mcpServers\": {\n  \"context7\": {\n    \"type\": \"stdio\",\n    \"command\": \"npx\",\n    \"args\": [\n      \"-y\",\n      \"@upstash/context7-mcp\"\n    ],\n    \"env\": {}\n  }\n}"
    );
    assert_eq!(preview.notes.iter().map(|n| n.text.as_str()).collect::<Vec<_>>(), vec!["`startup_timeout_sec` stays in Codex only"]);
    apply_in(&rig.homes, &changes, &preview.token).unwrap();
    let after = fs::read_to_string(&rig.homes.claude_json).unwrap();
    // Only the new entry is added: the file is the old one with it spliced in.
    let insert = ",\n    \"context7\": {\n      \"type\": \"stdio\",\n      \"command\": \"npx\",\n      \"args\": [\n        \"-y\",\n        \"@upstash/context7-mcp\"\n      ],\n      \"env\": {}\n    }";
    let anchor = "      \"url\": \"https://events.example.com/sse\"\n    }";
    assert_eq!(after, before.replacen(anchor, &format!("{anchor}{insert}"), 1));
    assert_eq!(fs::read_to_string(rig.homes.home.join(format!(".claude.json.bak-{}", today()))).unwrap(), before);
    assert_eq!(item(&compare_in(&rig.homes).unwrap(), Kind::Mcp, "context7").status, Status::Same);
}

#[test]
fn a_preview_writes_nothing() {
    let rig = rig();
    let before = snapshot(&rig.homes.home);
    preview_in(&rig.homes, &[
        change(Kind::Mcp, "linear", Direction::ToCodex),
        change(Kind::Mcp, "context7", Direction::ToClaude),
        change(Kind::Command, "review", Direction::ToCodex),
        change(Kind::Skill, "pdf-tools", Direction::ToCodex),
    ])
    .unwrap();
    assert_eq!(snapshot(&rig.homes.home), before);
}

#[test]
fn apply_refuses_files_that_changed_since_the_preview() {
    let rig = rig();
    let changes = [change(Kind::Mcp, "linear", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    fs::write(rig.homes.codex_toml(), "model = \"other\"\n").unwrap();
    let error = apply_in(&rig.homes, &changes, &preview.token).unwrap_err();
    assert_eq!(error.to_string(), "Nothing was written: these files changed since the preview. Look over the new preview and apply again.");
    assert_eq!(fs::read_to_string(rig.homes.codex_toml()).unwrap(), "model = \"other\"\n");
}

#[test]
fn a_second_backup_on_one_day_gets_a_number() {
    let rig = rig();
    apply_now(&rig.homes, &[change(Kind::Mcp, "linear", Direction::ToCodex)]);
    let written = apply_now(&rig.homes, &[change(Kind::Mcp, "playwright", Direction::ToCodex)]);
    assert_eq!(written[0].backup.as_deref(), Some(format!("~/.codex/config.toml.bak-{}.2", today()).as_str()));
}

#[test]
fn commands_keep_the_frontmatter_both_agents_read() {
    let rig = rig();
    let changes = [change(Kind::Command, "review", Direction::ToCodex), change(Kind::Command, "draftpr", Direction::ToClaude)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    let notes: Vec<_> = preview.notes.iter().map(|n| (n.name.as_str(), n.text.as_str())).collect();
    assert_eq!(
        notes,
        vec![
            ("draftpr", "Claude Code does not fill named placeholders ($FILES, $TICKET); it fills $ARGUMENTS and $1…$9"),
            ("review", "`allowed-tools` stays in Claude Code only"),
            ("review", "`model` stays in Claude Code only"),
            ("review", "Codex does not run !`…` lines; they are copied as text"),
        ]
    );
    let written = apply_in(&rig.homes, &changes, &preview.token).unwrap();
    assert!(written.iter().all(|w| w.backup.is_none()), "new files have nothing to back up");
    assert_eq!(
        fs::read_to_string(rig.homes.codex_dir.join("prompts/review.md")).unwrap(),
        "---\ndescription: Review the current branch against main\nargument-hint: [focus]\n---\nReview the changes on this branch against main. Focus on $ARGUMENTS.\n\nCurrent diff: !`git diff main...HEAD --stat`\n"
    );
    assert_eq!(fs::read(rig.homes.claude_dir.join("commands/draftpr.md")).unwrap(), fs::read(rig.homes.codex_dir.join("prompts/draftpr.md")).unwrap());
    let c = compare_in(&rig.homes).unwrap();
    assert_eq!(item(&c, Kind::Command, "review").status, Status::Same);
    assert_eq!(item(&c, Kind::Command, "draftpr").status, Status::Same);
}

#[test]
fn a_replaced_command_is_backed_up_beside_itself() {
    let rig = rig();
    let path = rig.homes.codex_dir.join("prompts/changelog.md");
    fs::write(&path, "Write a changelog entry.\n").unwrap();
    let written = apply_now(&rig.homes, &[change(Kind::Command, "changelog", Direction::ToCodex)]);
    assert_eq!(fs::read_to_string(rig.homes.codex_dir.join(format!("prompts/changelog.md.bak-{}", today()))).unwrap(), "Write a changelog entry.\n");
    assert_eq!(written[0].path, "~/.codex/prompts/changelog.md");
    assert_eq!(fs::read(&path).unwrap(), fs::read(rig.homes.claude_dir.join("commands/changelog.md")).unwrap());
}

#[cfg(unix)]
#[test]
fn a_skill_copies_over_keeping_files_only_the_target_had() {
    use std::os::unix::fs::PermissionsExt;
    let rig = rig();
    let changes = [change(Kind::Skill, "pdf-tools", Direction::ToCodex), change(Kind::Skill, "release-notes", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    let pdf = preview.files.iter().find(|f| f.path == "~/.codex/skills/pdf-tools/").unwrap();
    // fill.sh is already the same, so only SKILL.md is written.
    assert!(pdf.text.starts_with("SKILL.md · "), "{}", pdf.text);
    assert!(!pdf.text.contains("scripts/fill.sh ·"), "{}", pdf.text);
    assert!(pdf.text.contains("description: Fill and merge PDF forms"));
    assert_eq!(pdf.backup.as_deref(), Some(format!("~/terminalx/backups/skills/codex/pdf-tools.bak-{}", today()).as_str()));
    let fresh = preview.files.iter().find(|f| f.path == "~/.codex/skills/release-notes/").unwrap();
    assert_eq!(fresh.backup, None);
    assert!(preview.notes.iter().any(|n| n.name == "pdf-tools" && n.text == "1 file only the other side has stays"));
    assert_eq!((preview.added.skill, preview.replaced.skill), (1, 1));

    apply_in(&rig.homes, &changes, &preview.token).unwrap();
    let codex = rig.homes.codex_dir.join("skills");
    assert_eq!(fs::read(codex.join("pdf-tools/SKILL.md")).unwrap(), fs::read(rig.homes.claude_dir.join("skills/pdf-tools/SKILL.md")).unwrap());
    assert_eq!(fs::read_to_string(codex.join("pdf-tools/extra/notes.md")).unwrap(), "Codex-only notes\n");
    assert!(fs::metadata(codex.join("pdf-tools/scripts/fill.sh")).unwrap().permissions().mode() & 0o100 != 0);
    let backup = rig.homes.backups.join(format!("skills/codex/pdf-tools.bak-{}", today()));
    assert_eq!(fs::read_to_string(backup.join("SKILL.md")).unwrap(), "---\nname: pdf-tools\ndescription: Fill PDF forms\n---\nRun scripts/fill.sh with the form.\n");
    assert!(codex.join("release-notes/SKILL.md").is_file());
    // The Codex-only file keeps the two apart, as it should: nothing is deleted.
    assert_eq!(item(&compare_in(&rig.homes).unwrap(), Kind::Skill, "pdf-tools").status, Status::Different);
    assert_eq!(item(&compare_in(&rig.homes).unwrap(), Kind::Skill, "release-notes").status, Status::Same);
}

#[test]
fn missing_files_are_created_and_broken_ones_are_reported() {
    let rig = rig();
    fs::remove_file(rig.homes.codex_toml()).unwrap();
    let written = apply_now(&rig.homes, &[change(Kind::Mcp, "linear", Direction::ToCodex)]);
    assert_eq!(written[0].backup, None);
    assert_eq!(fs::read_to_string(rig.homes.codex_toml()).unwrap(), "[mcp_servers.linear]\nurl = \"https://mcp.linear.app/mcp\"\n");

    fs::write(rig.homes.codex_toml(), "model = [unclosed\n").unwrap();
    let c = compare_in(&rig.homes).unwrap();
    assert_eq!(c.problems.len(), 1);
    assert!(c.problems[0].starts_with("~/.codex/config.toml: not valid TOML"), "{:?}", c.problems);
    assert!(preview_in(&rig.homes, &[change(Kind::Mcp, "playwright", Direction::ToCodex)]).is_err());
}

#[test]
fn frontmatter_splits_into_keys_with_their_lines() {
    let (blocks, body) = split_frontmatter("---\ndescription: >\n  folded\n  text\nallowed-tools:\n  - Bash\n---\nbody\n").unwrap();
    assert_eq!(blocks, vec![("description".to_string(), "description: >\n  folded\n  text\n".to_string()), ("allowed-tools".to_string(), "allowed-tools:\n  - Bash\n".to_string())]);
    assert_eq!(body, "body\n");
    assert_eq!(frontmatter_value("---\ndescription: >\n  folded\n  text\n---\n", "description").as_deref(), Some("folded text"));
    assert!(split_frontmatter("no frontmatter").is_none());
}

#[test]
fn a_replaced_codex_server_keeps_its_own_settings_and_says_so() {
    let rig = rig();
    let toml_path = rig.homes.codex_toml();
    let text = fs::read_to_string(&toml_path).unwrap().replace(
        "bearer_token_env_var = \"SENTRY_TOKEN\"\n",
        "bearer_token_env_var = \"SENTRY_TOKEN\"\nenabled = false\nstartup_timeout_sec = 30\n",
    );
    fs::write(&toml_path, text).unwrap();
    let changes = [change(Kind::Mcp, "sentry", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    let notes: Vec<_> = preview.notes.iter().map(|n| n.text.as_str()).collect();
    assert_eq!(notes, vec!["keeps Codex's own `enabled`, `startup_timeout_sec`", "stays turned off in Codex"]);
    assert!(preview.files[0].text.contains("enabled = false\nstartup_timeout_sec = 30\n"), "{}", preview.files[0].text);
    apply_in(&rig.homes, &changes, &preview.token).unwrap();
    let parsed: toml::Table = toml::from_str(&fs::read_to_string(&toml_path).unwrap()).unwrap();
    let sentry = &parsed["mcp_servers"]["sentry"];
    assert_eq!(sentry["url"].as_str(), Some("https://mcp.sentry.dev/mcp"));
    assert_eq!(sentry["enabled"].as_bool(), Some(false));
    assert_eq!(sentry["startup_timeout_sec"].as_integer(), Some(30));
}

#[test]
fn a_replaced_claude_server_keeps_its_own_settings() {
    let rig = rig();
    let text = fs::read_to_string(&rig.homes.claude_json).unwrap().replace(
        "      \"url\": \"https://mcp.sentry.dev/mcp\",\n",
        "      \"url\": \"https://mcp.sentry.dev/mcp\",\n      \"oauth\": { \"clientId\": \"abc\" },\n",
    );
    fs::write(&rig.homes.claude_json, text).unwrap();
    let changes = [change(Kind::Mcp, "sentry", Direction::ToClaude)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    assert!(preview.notes.iter().any(|n| n.text == "keeps Claude Code's own `oauth`"), "{:?}", preview.notes);
    apply_in(&rig.homes, &changes, &preview.token).unwrap();
    let after: Value = serde_json::from_str(&fs::read_to_string(&rig.homes.claude_json).unwrap()).unwrap();
    let sentry = &after["mcpServers"]["sentry"];
    assert_eq!(sentry["url"], "https://sentry.internal.example.com/mcp");
    assert_eq!(sentry["headers"]["Authorization"], "Bearer ${SENTRY_TOKEN}");
    assert_eq!(sentry["oauth"]["clientId"], "abc");
}

#[test]
fn a_name_codex_cannot_key_is_refused_even_straight_to_preview() {
    let rig = rig();
    let text = fs::read_to_string(&rig.homes.claude_json).unwrap().replacen("\"mcpServers\": {\n", "\"mcpServers\": {\n    \"my.server\": { \"command\": \"x\" },\n", 1);
    fs::write(&rig.homes.claude_json, text).unwrap();
    assert!(item(&compare_in(&rig.homes).unwrap(), Kind::Mcp, "my.server").to_codex_blocked.is_some());
    let error = preview_in(&rig.homes, &[change(Kind::Mcp, "my.server", Direction::ToCodex)]).unwrap_err();
    assert!(error.to_string().contains("Codex server names use only letters"), "{error}");
}

#[cfg(unix)]
#[test]
fn a_skill_linking_out_of_its_folder_is_not_copied() {
    let rig = rig();
    let secret = rig.homes.home.join("secret-key");
    fs::write(&secret, "private").unwrap();
    std::os::unix::fs::symlink(&secret, rig.homes.claude_dir.join("skills/release-notes/key")).unwrap();
    let c = compare_in(&rig.homes).unwrap();
    assert_eq!(item(&c, Kind::Skill, "release-notes").to_codex_blocked.as_deref(), Some("can't be copied: key links outside the skill folder"));
    assert!(preview_in(&rig.homes, &[change(Kind::Skill, "release-notes", Direction::ToCodex)]).is_err());
    // A link that stays inside the folder is fine.
    fs::remove_file(rig.homes.claude_dir.join("skills/release-notes/key")).unwrap();
    std::os::unix::fs::symlink("SKILL.md", rig.homes.claude_dir.join("skills/release-notes/README.md")).unwrap();
    assert_eq!(item(&compare_in(&rig.homes).unwrap(), Kind::Skill, "release-notes").to_codex_blocked, None);
}

#[cfg(unix)]
#[test]
fn a_linked_config_file_stays_a_link() {
    let rig = rig();
    let dotfiles = rig.homes.home.join("dotfiles");
    fs::create_dir_all(&dotfiles).unwrap();
    fs::rename(rig.homes.codex_toml(), dotfiles.join("config.toml")).unwrap();
    std::os::unix::fs::symlink(dotfiles.join("config.toml"), rig.homes.codex_toml()).unwrap();
    let before = fs::read_to_string(dotfiles.join("config.toml")).unwrap();
    apply_now(&rig.homes, &[change(Kind::Mcp, "linear", Direction::ToCodex)]);
    assert!(fs::symlink_metadata(rig.homes.codex_toml()).unwrap().file_type().is_symlink());
    assert!(fs::read_to_string(dotfiles.join("config.toml")).unwrap().contains("[mcp_servers.linear]"));
    let backup = rig.homes.codex_dir.join(format!("config.toml.bak-{}", today()));
    assert!(fs::symlink_metadata(&backup).unwrap().is_file());
    assert_eq!(fs::read_to_string(backup).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn a_write_that_fails_part_way_names_what_was_already_written() {
    use std::os::unix::fs::PermissionsExt;
    let rig = rig();
    let changes = [change(Kind::Skill, "release-notes", Direction::ToCodex), change(Kind::Mcp, "linear", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    // The skill lands in ~/.codex/skills; config.toml's backup beside it in ~/.codex cannot.
    fs::set_permissions(&rig.homes.codex_dir, fs::Permissions::from_mode(0o555)).unwrap();
    let error = apply_in(&rig.homes, &changes, &preview.token).unwrap_err().to_string();
    fs::set_permissions(&rig.homes.codex_dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.starts_with("Wrote ~/.codex/skills/release-notes, then stopped: back up ~/.codex/config.toml"), "{error}");
    assert!(error.ends_with("Nothing after that was written."), "{error}");
}

/// release-notes given a second file, `scripts/build.sh`, whose folder on the
/// Codex side cannot be written into: SKILL.md lands, then the copy stops.
/// Returns the Codex target and its read-only `scripts` folder.
#[cfg(unix)]
fn skill_that_stops_after_its_first_file(rig: &Rig) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let source = rig.homes.claude_dir.join("skills/release-notes");
    fs::create_dir_all(source.join("scripts")).unwrap();
    fs::write(source.join("scripts/build.sh"), "#!/bin/sh\necho notes\n").unwrap();
    let target = rig.homes.codex_dir.join("skills/release-notes");
    let scripts = target.join("scripts");
    fs::create_dir_all(&scripts).unwrap();
    fs::set_permissions(&scripts, fs::Permissions::from_mode(0o555)).unwrap();
    (target, scripts)
}

#[cfg(unix)]
fn writable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
#[test]
fn a_skill_copy_that_stops_first_names_the_files_it_wrote() {
    let rig = rig();
    let (target, scripts) = skill_that_stops_after_its_first_file(&rig);
    let changes = [change(Kind::Skill, "release-notes", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    let error = apply_in(&rig.homes, &changes, &preview.token).unwrap_err().to_string();
    writable(&scripts);
    let backup = format!("~/terminalx/backups/skills/codex/release-notes.bak-{}", today());
    assert!(
        error.starts_with(&format!("Wrote 1 of 2 files into ~/.codex/skills/release-notes (SKILL.md; backed up to {backup}), then stopped: write ~/.codex/skills/release-notes/scripts/build.sh: ")),
        "{error}"
    );
    assert!(error.ends_with("Nothing after that was written."), "{error}");
    assert!(!error.contains("Nothing was written"), "{error}");
    // What the message says is what is on disk.
    assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), fs::read(rig.homes.claude_dir.join("skills/release-notes/SKILL.md")).unwrap());
    assert!(!scripts.join("build.sh").exists());
    assert!(rig.homes.backups.join(format!("skills/codex/release-notes.bak-{}", today())).join("scripts").is_dir());
}

#[cfg(unix)]
#[test]
fn a_skill_copy_that_stops_after_an_earlier_write_names_both() {
    let rig = rig();
    let (target, scripts) = skill_that_stops_after_its_first_file(&rig);
    let changes = [change(Kind::Command, "review", Direction::ToCodex), change(Kind::Skill, "release-notes", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    let error = apply_in(&rig.homes, &changes, &preview.token).unwrap_err().to_string();
    writable(&scripts);
    assert!(
        error.starts_with("Wrote ~/.codex/prompts/review.md, 1 of 2 files into ~/.codex/skills/release-notes (SKILL.md; backed up to "),
        "{error}"
    );
    assert!(error.contains("then stopped: write ~/.codex/skills/release-notes/scripts/build.sh: "), "{error}");
    assert!(error.ends_with("Nothing after that was written."), "{error}");
    assert!(rig.homes.codex_dir.join("prompts/review.md").is_file());
    assert!(target.join("SKILL.md").is_file());
    assert!(!scripts.join("build.sh").exists());
}

/// A skill copy that fails on its first file wrote nothing of its own, but its
/// backup stays and is named.
#[cfg(unix)]
#[test]
fn a_skill_copy_that_fails_on_its_first_file_names_its_backup() {
    use std::os::unix::fs::PermissionsExt;
    let rig = rig();
    let target = unlisted_codex_target(&rig);
    let changes = [change(Kind::Skill, "release-notes", Direction::ToCodex)];
    let preview = preview_in(&rig.homes, &changes).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o555)).unwrap();
    let error = apply_in(&rig.homes, &changes, &preview.token).unwrap_err().to_string();
    writable(&target);
    assert!(error.starts_with("Nothing was written: write ~/.codex/skills/release-notes/SKILL.md: "), "{error}");
    assert!(error.ends_with(&format!("A backup was made at ~/terminalx/backups/skills/codex/release-notes.bak-{} first.", today())), "{error}");
    assert!(!target.join("SKILL.md").exists());
}

/// A Codex folder named like a Claude skill but without SKILL.md: not a listed
/// skill, yet every file of the copy lands in it.
#[cfg(unix)]
fn unlisted_codex_target(rig: &Rig) -> PathBuf {
    let target = rig.homes.codex_dir.join("skills/release-notes");
    fs::create_dir_all(&target).unwrap();
    assert!(!compare_in(&rig.homes).unwrap().items.iter().any(|i| i.kind == Kind::Skill && i.name == "release-notes" && i.codex_summary.is_some()));
    target
}

/// Copies release-notes to Codex alongside an MCP server and expects a refusal
/// that leaves `outside` and both homes exactly as they were.
#[cfg(unix)]
fn refused_with_nothing_written(rig: &Rig, outside: &Path, expected: &str) {
    let before = (snapshot(outside), snapshot(&rig.homes.codex_dir), snapshot(&rig.homes.claude_dir));
    let changes = [change(Kind::Skill, "release-notes", Direction::ToCodex), change(Kind::Mcp, "linear", Direction::ToCodex)];
    let error = preview_in(&rig.homes, &changes).unwrap_err().to_string();
    assert!(error.contains(expected), "{error}");
    // Even with a token from a preview that did pass, apply plans again and refuses first.
    let error = apply_in(&rig.homes, &changes, "any").unwrap_err().to_string();
    assert!(error.starts_with("Nothing was written: "), "{error}");
    assert!(error.contains(expected), "{error}");
    assert_eq!((snapshot(outside), snapshot(&rig.homes.codex_dir), snapshot(&rig.homes.claude_dir)), before);
    assert!(!rig.homes.backups.exists());
}

#[cfg(unix)]
#[test]
fn an_unlisted_target_linking_a_file_outside_is_not_written_through() {
    let rig = rig();
    let outside = rig.homes.home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("SKILL.md"), "not a skill").unwrap();
    let target = unlisted_codex_target(&rig);
    // Not a file the copy writes, but it makes the folder unsafe to write into.
    std::os::unix::fs::symlink(outside.join("SKILL.md"), target.join("SKILL.md.link")).unwrap();
    refused_with_nothing_written(&rig, &outside, "release-notes` on the other side can't be copied over: SKILL.md.link links outside the skill folder");
}

#[cfg(unix)]
#[test]
fn an_unlisted_target_whose_skill_file_is_a_link_out_is_refused() {
    let rig = rig();
    let outside = rig.homes.home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    // A link at SKILL.md itself to a file that is not there yet: `is_file` is
    // false, so the folder is not listed, and a write through it would create the file outside.
    let target = unlisted_codex_target(&rig);
    std::os::unix::fs::symlink(outside.join("planted.md"), target.join("SKILL.md")).unwrap();
    refused_with_nothing_written(&rig, &outside, "SKILL.md is a broken link");
    assert!(!outside.join("planted.md").exists());
}

#[cfg(unix)]
#[test]
fn an_unlisted_target_linking_a_folder_outside_is_not_written_through() {
    let rig = rig();
    let outside = rig.homes.home.join("outside");
    fs::create_dir_all(outside.join("scripts")).unwrap();
    fs::write(outside.join("scripts/fill.sh"), "#!/bin/sh\necho mine\n").unwrap();
    let target = rig.homes.codex_dir.join("skills/pdf-tools");
    fs::remove_file(target.join("SKILL.md")).unwrap();
    fs::remove_dir_all(target.join("scripts")).unwrap();
    std::os::unix::fs::symlink(outside.join("scripts"), target.join("scripts")).unwrap();
    let before = (snapshot(&outside), snapshot(&rig.homes.codex_dir));
    let changes = [change(Kind::Skill, "pdf-tools", Direction::ToCodex), change(Kind::Mcp, "linear", Direction::ToCodex)];
    let error = apply_in(&rig.homes, &changes, "any").unwrap_err().to_string();
    assert_eq!(error, "Nothing was written: skill `pdf-tools` on the other side can't be copied over: scripts links outside the skill folder");
    assert_eq!((snapshot(&outside), snapshot(&rig.homes.codex_dir)), before);
    assert!(!rig.homes.backups.exists());
}

#[cfg(unix)]
#[test]
fn a_linked_target_folder_without_skill_md_is_refused() {
    let rig = rig();
    let outside = rig.homes.home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("keep.txt"), "mine").unwrap();
    std::os::unix::fs::symlink(&outside, rig.homes.codex_dir.join("skills/release-notes")).unwrap();
    refused_with_nothing_written(&rig, &outside, "skill `release-notes` on the other side links to ~/outside; change that folder instead");
}

/// A relative link is named by where it leads, not as `..` segments.
#[cfg(unix)]
#[test]
fn a_relative_linked_target_folder_is_named_by_where_it_leads() {
    let rig = rig();
    let outside = rig.homes.home.join("outside");
    fs::create_dir_all(rig.homes.home.join("elsewhere")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink("../../elsewhere/../outside/.", rig.homes.codex_dir.join("skills/release-notes")).unwrap();
    refused_with_nothing_written(&rig, &outside, "skill `release-notes` on the other side links to ~/outside; change that folder instead");
}

#[cfg(unix)]
#[test]
fn a_dangling_linked_target_folder_names_where_it_would_lead() {
    let rig = rig();
    let outside = rig.homes.home.join("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink("../../outside/gone", rig.homes.codex_dir.join("skills/release-notes")).unwrap();
    refused_with_nothing_written(&rig, &outside, "skill `release-notes` on the other side links to ~/outside/gone, which is not there; change that folder instead");
    assert!(!outside.join("gone").exists());
}

/// A link that cannot be read (here: not a link at all, which `read_link`
/// refuses the same way) is still named as something, never as nothing.
#[test]
fn an_unreadable_link_is_never_named_empty() {
    let rig = rig();
    let gone = rig.homes.codex_dir.join("skills/not-there");
    let shown = link_shown(&rig.homes, &gone);
    assert!(shown.starts_with("a place that can't be read ("), "{shown}");
    assert!(shown.len() > "a place that can't be read ()".len(), "{shown}");
}

#[cfg(unix)]
#[test]
fn an_unlisted_target_with_inside_links_and_clashing_paths() {
    let rig = rig();
    let target = unlisted_codex_target(&rig);
    // A link that stays inside the folder is written through, as before.
    fs::write(target.join("real.md"), "old").unwrap();
    std::os::unix::fs::symlink("real.md", target.join("SKILL.md")).unwrap();
    apply_now(&rig.homes, &[change(Kind::Skill, "release-notes", Direction::ToCodex)]);
    assert!(fs::symlink_metadata(target.join("SKILL.md")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(target.join("real.md")).unwrap(), fs::read(rig.homes.claude_dir.join("skills/release-notes/SKILL.md")).unwrap());

    // A folder where the copy writes a file is refused before anything is written.
    let pdf = rig.homes.codex_dir.join("skills/pdf-tools");
    fs::remove_file(pdf.join("SKILL.md")).unwrap();
    fs::create_dir_all(pdf.join("SKILL.md")).unwrap();
    let error = preview_in(&rig.homes, &[change(Kind::Skill, "pdf-tools", Direction::ToCodex)]).unwrap_err().to_string();
    assert_eq!(error, "skill `pdf-tools` can't be copied over: SKILL.md is a folder on the other side");
    // A file where the copy needs a folder, likewise.
    fs::remove_dir_all(pdf.join("SKILL.md")).unwrap();
    fs::remove_dir_all(pdf.join("scripts")).unwrap();
    fs::write(pdf.join("scripts"), "a file").unwrap();
    let error = preview_in(&rig.homes, &[change(Kind::Skill, "pdf-tools", Direction::ToCodex)]).unwrap_err().to_string();
    assert_eq!(error, "skill `pdf-tools` can't be copied over: scripts is a file on the other side");
}

/// A skill copy whose first file can't be read once its folders are made
/// (its source went away): what is on disk and what the receipt says agree.
fn copy_of_a_vanished_file(rig: &Rig, target: &Path) -> (Result<Written, Box<Stopped>>, PathBuf) {
    let source = rig.homes.home.join("source");
    fs::create_dir_all(&source).unwrap();
    let files = vec![SkillFile { rel: "scripts/deep/run.sh".into(), hash: [0; 32], len: 0, executable: false }];
    let write = Write::Skill { source: source.clone(), target: target.to_path_buf(), files, exists: target.exists() };
    (apply_one(&rig.homes, &write, &today()), source)
}

#[test]
fn a_skill_copy_that_stops_before_its_first_file_takes_back_the_folders_it_made() {
    let rig = rig();
    let skills = rig.homes.codex_dir.join("skills");
    let before = snapshot(&skills);
    let target = skills.join("new-skill");
    let (result, _) = copy_of_a_vanished_file(&rig, &target);
    let Err(stopped) = result else { panic!("the copy went through") };
    let error = stopped_message(&rig.homes, &[], &stopped);
    assert!(error.starts_with("Nothing was written: read "), "{error}");
    assert!(!error.contains("still there"), "{error}");
    // Nothing of this attempt is left, and the folder it went into stays.
    assert!(!target.exists());
    assert!(skills.is_dir());
    assert_eq!(snapshot(&skills), before);
}

#[test]
fn a_stopped_skill_copy_keeps_folders_that_were_already_there() {
    let rig = rig();
    let target = rig.homes.codex_dir.join("skills/new-skill");
    fs::create_dir_all(target.join("scripts")).unwrap();
    let (result, _) = copy_of_a_vanished_file(&rig, &target);
    let Err(stopped) = result else { panic!("the copy went through") };
    assert!(stopped.made.is_empty());
    assert!(target.join("scripts").is_dir());
    assert!(!target.join("scripts/deep").exists());
}

/// A folder made for a write that could not be taken back is named, so the
/// receipt never says "nothing" while it is on disk.
#[test]
fn a_folder_left_behind_is_named() {
    let rig = rig();
    let made = rig.homes.codex_dir.join("skills/new-skill");
    let stopped = |made: Vec<PathBuf>| Stopped { error: anyhow!("boom"), target: rig.homes.codex_dir.join("skills/new-skill"), backup: None, copied: Vec::new(), mode_unset: None, of: 1, made };
    assert_eq!(stopped_message(&rig.homes, &[], &stopped(vec![made.clone()])), "No file was written: boom. The folder ~/.codex/skills/new-skill made for it is still there.");
    assert_eq!(
        stopped_message(&rig.homes, &[], &stopped(vec![made.clone(), made.join("scripts")])),
        "No file was written: boom. The folders ~/.codex/skills/new-skill, ~/.codex/skills/new-skill/scripts made for it are still there."
    );
    let done = [Written { path: "~/.codex/prompts/review.md".into(), backup: None }];
    assert_eq!(
        stopped_message(&rig.homes, &done, &stopped(vec![made])),
        "Wrote ~/.codex/prompts/review.md, then stopped: boom. Nothing after that was written. The folder ~/.codex/skills/new-skill made for it is still there."
    );
}
