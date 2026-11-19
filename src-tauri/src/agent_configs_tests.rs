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
            if path.is_dir() {
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
        (claude_entry(&server.transport.unwrap(), 0), server.stays)
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
    assert!(error.to_string().contains("changed since the preview"), "{error}");
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
