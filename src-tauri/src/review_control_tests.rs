use super::super::tests::headless_service as bare_service;
use super::*;

fn session(root: &Path) -> SessionEntry {
    if !crate::git::is_repo(root) {
        crate::git::run(root, &["init", "-b", "main"]).unwrap();
        for entry in std::fs::read_dir(root).unwrap().map(Result::unwrap) {
            if entry.file_type().unwrap().is_file()
                && entry.metadata().unwrap().len() <= 4 * 1024 * 1024
            {
                crate::git::run(root, &["add", "--", entry.file_name().to_str().unwrap()]).unwrap();
            }
        }
        crate::git::run(
            root,
            &[
                "-c",
                "user.name=Reviewer Test",
                "-c",
                "user.email=review@example.com",
                "commit",
                "--allow-empty",
                "-m",
                "reviewed",
            ],
        )
        .unwrap();
    }
    let commit = crate::git::head_commit(root).unwrap();
    let mut session = crate::session_ops::create_session_entry(
        serde_json::from_value(json!({
            "projectPath": root, "useWorktree": false, "tab": {"harness": "codex"},
        }))
        .unwrap(),
    )
    .unwrap();
    session.tabs[0].title = Some("  Reviewer\n  \t".into());
    let mut author = session.tabs[0].clone();
    author.id = uuid::Uuid::now_v7().to_string();
    session.tabs.push(author);
    let pipeline = serde_json::from_value(json!({
        "id": session.id, "projectPath": session.project_path, "branch": "reviewed",
        "author": {"sessionId": session.id, "tabId": session.tabs[1].id},
        "reviewer": {"sessionId": session.id, "tabId": session.tabs[0].id},
        "stage": "review", "state": "working", "reviewCommit": commit, "pr": {"number": 1, "url": "https://example.com/pr/1", "base": "main"},
        "maxRounds": 3, "created": "now", "modified": "now",
    }))
    .unwrap();
    crate::issue_pipeline::store::insert(&pipeline).unwrap();
    index::update_session(&session.id, |stored| {
        *stored = session.clone();
        Ok(())
    })
    .unwrap();
    session
}

fn headless_service() -> (ControlService, Arc<crate::sink::BroadcastSink>) {
    let (service, sink) = bare_service();
    for session in index::load().unwrap() {
        for tab in session.tabs {
            service.manager.install_review_test_cli(
                &session.id,
                &tab.id,
                &format!("secret-{}", tab.id),
            );
        }
    }
    (service, sink)
}

fn params(session: &SessionEntry) -> Value {
    json!({"hookToken": format!("secret-{}", session.tabs[0].id), "caller": {"session": session.id, "tab": session.tabs[0].id, "cwd": "/unrelated"},
        "file": "foo.ts", "line": "2-3", "body": "High: validate before writing.\nThe request may be empty."})
}

#[test]
fn saves_the_exact_range_with_tab_attribution_and_a_persisted_chat_card() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\r\nsecond\r\nthird").unwrap();
    let session = session(root.path());
    let request = params(&session);
    let (service, _) = headless_service();
    let result = service
        .execute("review.comment", request.clone(), "one")
        .unwrap();
    assert_eq!(
        result["workspace"],
        review_comments::workspace_key(Path::new(&session.cwd)).unwrap()
    );
    let comment = &result["comment"];
    assert_eq!(comment["path"], "foo.ts");
    assert_eq!(comment["side"], "after");
    assert_eq!(comment["startLine"], 2);
    assert_eq!(comment["endLine"], 3);
    assert_eq!(comment["lineText"], "second\nthird");
    assert_eq!(
        comment["author"],
        json!({"kind": "agent", "role": "reviewer", "sessionId": session.id, "tabId": session.tabs[0].id, "name": "Reviewer"})
    );
    let events = service
        .manager
        .load_events(&session.id, &session.tabs[0].id)
        .unwrap();
    assert_eq!(events.len(), 2);
    assert!(!serde_json::to_string(&events).unwrap().contains("secret-"));
    assert!(!serde_json::to_string(&result).unwrap().contains("secret-"));
    assert!(
        matches!(&events[0].payload, Payload::ToolCallStarted { name, input, .. } if name == "terminalx.review.comment" && input["lineText"] == comment["lineText"] && input["quotedLineCount"] == 2)
    );
    assert!(
        matches!(&events[1].payload, Payload::ToolCallCompleted { result, .. } if !result.is_error && result.structured.is_none())
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("foo.ts")).unwrap(),
        "first\r\nsecond\r\nthird"
    );

    // A fresh service and the desktop UI read the exact same store and schema.
    drop(service);
    let (service, _) = headless_service();
    let listed = service
        .execute("review.comments", request.clone(), "two")
        .unwrap();
    assert_eq!(listed["comments"], json!([comment]));
    let ui_comments = review_comments::apply(
        &crate::store::root().unwrap(),
        &review_comments::workspace_key(Path::new(&session.cwd)).unwrap(),
        Action::List,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&ui_comments).unwrap(),
        json!([comment])
    );
    assert_eq!(ui_comments[0].note, request["body"].as_str().unwrap());
    assert_eq!(ui_comments[0].revision, 1);
    assert!(!ui_comments[0].sent && !ui_comments[0].outdated);
}

#[test]
fn comments_are_shared_in_one_workspace_and_never_in_another() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "a\nb\nc\n").unwrap();
    let first = session(root.path());
    let same = session(root.path());
    let different = session(other.path());
    let (service, _) = headless_service();
    service
        .execute("review.comment", params(&first), "one")
        .unwrap();
    assert_eq!(
        service
            .execute("review.comments", params(&same), "two")
            .unwrap()["comments"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        service
            .execute("review.comments", params(&different), "three")
            .unwrap()["comments"],
        json!([])
    );
    for caller in [
        json!({}),
        json!({"session": first.id}),
        json!({"session": first.id, "tab": different.tabs[0].id}),
        json!({"session": "missing", "tab": first.tabs[0].id}),
    ] {
        for command in ["review.comment", "review.comments"] {
            let mut request = params(&first);
            request["caller"] = caller.clone();
            assert!(service.execute(command, request, "bad").is_err());
        }
    }
}

#[test]
fn user_and_agent_comments_share_edit_sent_and_outdated_lifecycle() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\nsecond\nthird").unwrap();
    let session = session(root.path());
    let workspace = review_comments::workspace_key(Path::new(&session.cwd)).unwrap();
    let store = crate::store::root().unwrap();
    let anchor = json!({"path": "foo.ts", "side": "after", "startLine": 2, "endLine": 3, "lineText": "second\nthird", "base": crate::git::head_tree(root.path()).unwrap()});
    // The existing desktop action has no author field; its record stays a user note.
    let user = serde_json::from_value(
        json!({"type": "save", "anchor": anchor, "note": "User note", "expected": null}),
    )
    .unwrap();
    review_comments::apply(&store, &workspace, user).unwrap();
    let (service, _) = headless_service();
    let saved = service
        .execute("review.comment", params(&session), "agent")
        .unwrap()["comment"]
        .clone();
    let listed = review_comments::apply(&store, &workspace, Action::List).unwrap();
    assert_eq!(listed.len(), 2);
    assert!(matches!(listed[0].author.kind, AuthorKind::User));
    assert_eq!(serde_json::to_value(&listed[1]).unwrap(), saved);
    // The user's Edit action changes the note, while retaining agent attribution.
    let edit = serde_json::from_value(
        json!({"type": "save", "anchor": anchor, "note": "Clarified finding", "expected": saved}),
    )
    .unwrap();
    let edited = review_comments::apply(&store, &workspace, edit)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&edited.author).unwrap(),
        saved["author"]
    );
    let revision = || review_comments::Revision {
        id: edited.id.clone(),
        revision: edited.revision,
    };
    review_comments::apply(
        &store,
        &workspace,
        Action::Sent {
            comments: vec![revision()],
        },
    )
    .unwrap();
    review_comments::apply(
        &store,
        &workspace,
        Action::Reconcile {
            path: "foo.ts".into(),
            base: crate::git::head_tree(root.path()).unwrap(),
            before: None,
            after: Some("first\nchanged\nthird".into()),
            comments: vec![revision()],
        },
    )
    .unwrap();
    let listed = service
        .execute("review.comments", params(&session), "after-send")
        .unwrap();
    let agent = listed["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == saved["id"])
        .unwrap();
    assert_eq!(agent["note"], "Clarified finding");
    assert_eq!(agent["author"], saved["author"]);
    assert_eq!(agent["sent"], true);
    assert_eq!(agent["outdated"], true);
}

#[test]
fn cloud_runtime_refuses_to_write_a_store_the_desktop_cannot_read() {
    let _home = crate::store::temp_home();
    let (mut service, _) = headless_service();
    service.runtime_kind = Some("cloud-workspace".into());
    for command in ["review.comment", "review.comments"] {
        assert_eq!(
            service
                .execute(command, json!({}), "cloud")
                .unwrap_err()
                .code,
            "unsupported"
        );
    }
    assert!(!crate::store::root()
        .unwrap()
        .join("review-comments")
        .exists());
}

#[test]
fn preserves_spaces_in_filenames_and_uses_the_shared_note_normalization() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(" spaced.ts "), "const value = 1;\n").unwrap();
    let session = session(root.path());
    let (service, _) = headless_service();
    let mut request = params(&session);
    request["file"] = json!(" spaced.ts ");
    request["line"] = json!("1");
    request["body"] = json!("    suggestedCode();\n");
    let result = service
        .execute("review.comment", request.clone(), "one")
        .unwrap();
    assert_eq!(result["comment"]["path"], request["file"]);
    assert_eq!(result["comment"]["note"], "suggestedCode();");
}

#[test]
fn rejects_invalid_ranges_paths_and_nontext_without_saving_or_publishing() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "a\nb\n").unwrap();
    std::fs::write(root.path().join("empty"), "").unwrap();
    std::fs::write(root.path().join("binary"), b"a\0b").unwrap();
    std::fs::write(root.path().join("invalid-utf8"), b"\xff\xfe").unwrap();
    let large = std::fs::File::create(root.path().join("large")).unwrap();
    large.set_len(4 * 1024 * 1024 + 1).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), "private").unwrap();
    let session = session(root.path());
    let (service, sink) = headless_service();
    let mut heard = sink.subscribe();
    let mut request = params(&session);
    for line in [
        "0",
        "2-1",
        "3",
        "1-3",
        "-1",
        "1-",
        "1-2-3",
        "1.5",
        "+1",
        "4294967296",
        "",
    ] {
        request["line"] = json!(line);
        assert_eq!(
            service
                .execute("review.comment", request.clone(), "bad")
                .unwrap_err()
                .code,
            "invalid_arguments",
            "{line}"
        );
    }
    request["line"] = json!("1");
    for path in [
        "../secret",
        ".",
        "empty",
        "binary",
        "invalid-utf8",
        "large",
        "missing",
        "",
        outside.path().join("secret").to_str().unwrap(),
    ] {
        request["file"] = json!(path);
        assert_eq!(
            service
                .execute("review.comment", request.clone(), "bad")
                .unwrap_err()
                .code,
            "invalid_arguments",
            "{path}"
        );
    }
    request["file"] = json!("foo.ts");
    for body in [" \n".to_string(), "x".repeat(32 * 1024 + 1)] {
        request["body"] = json!(body);
        assert_eq!(
            service
                .execute("review.comment", request.clone(), "bad")
                .unwrap_err()
                .code,
            "invalid_arguments"
        );
    }
    assert_eq!(
        service
            .execute("review.comments", params(&session), "list")
            .unwrap()["comments"],
        json!([])
    );
    assert!(heard.try_recv().is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escapes_and_fifos_but_accepts_an_inside_absolute_path() {
    use std::os::unix::fs::symlink;
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\nsecond\n").unwrap();
    std::fs::write(outside.path().join("secret"), "private").unwrap();
    symlink(outside.path().join("secret"), root.path().join("link")).unwrap();
    symlink(outside.path(), root.path().join("directory")).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(root.path().join("fifo"))
        .status()
        .unwrap()
        .success());
    let session = session(root.path());
    let (service, _) = headless_service();
    let mut request = params(&session);
    request["line"] = json!("1");
    for path in ["link", "directory/secret", "fifo"] {
        request["file"] = json!(path);
        assert_eq!(
            service
                .execute("review.comment", request.clone(), "bad")
                .unwrap_err()
                .code,
            "invalid_arguments"
        );
    }
    request["file"] = json!(root.path().join("foo.ts"));
    let result = service.execute("review.comment", request, "good").unwrap();
    assert_eq!(result["comment"]["path"], "foo.ts");
    assert_eq!(result["comment"]["lineText"], "first");
}

#[test]
fn only_the_authenticated_pipeline_reviewer_can_write() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\nsecond\nthird").unwrap();
    let session = session(root.path());
    let ordinary = crate::session_ops::add_tab_entry(
        &session.id,
        &serde_json::from_value(json!({"harness": "codex"})).unwrap(),
    )
    .unwrap();
    let (service, _) = headless_service();
    let call = |params| {
        service.handle(ControlRequest {
            id: "auth".into(),
            token: service.endpoint.token.clone(),
            command: "review.comment".into(),
            params,
        })
    };
    // Each non-reviewer proves its own identity; neither has the reviewer role.
    for tab in [&session.tabs[1].id, &ordinary.id] {
        let mut request = params(&session);
        request["caller"]["tab"] = json!(tab);
        request["hookToken"] = json!(format!("secret-{tab}"));
        assert_eq!(call(request).error.unwrap().code, "forbidden");
    }
    // A correct app token and spoofed reviewer id do not prove tab identity.
    for token in [
        "".to_string(),
        service.endpoint.token.clone(),
        format!("secret-{}", session.tabs[1].id),
        format!("secret-{}", ordinary.id),
    ] {
        let mut request = params(&session);
        request["hookToken"] = json!(token);
        assert_eq!(call(request).error.unwrap().code, "unauthorized");
    }
    assert!(review_comments::apply(
        &crate::store::root().unwrap(),
        &review_comments::workspace_key(Path::new(&session.cwd)).unwrap(),
        Action::List
    )
    .unwrap()
    .is_empty());
    assert!(service
        .manager
        .load_events(&session.id, &session.tabs[0].id)
        .unwrap()
        .is_empty());
    assert!(call(params(&session)).ok);
    crate::issue_pipeline::store::set_switches(&session.id, |p| p.stopped = true).unwrap();
    assert_eq!(call(params(&session)).error.unwrap().code, "forbidden");
    // Restarting the reviewer invalidates its previous launch token.
    service
        .manager
        .install_review_test_cli(&session.id, &session.tabs[0].id, "replacement-token");
    assert_eq!(call(params(&session)).error.unwrap().code, "unauthorized");
}

#[test]
fn transcript_quotes_are_bounded_and_written_only_once() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    let quote = (0..30)
        .map(|n| format!("line {n}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(root.path().join("foo.ts"), &quote).unwrap();
    let session = session(root.path());
    let (service, _) = headless_service();
    let mut request = params(&session);
    request["line"] = json!("1-30");
    let saved = service.execute("review.comment", request, "quote").unwrap();
    assert_eq!(saved["comment"]["lineText"], quote);
    let events = service
        .manager
        .load_events(&session.id, &session.tabs[0].id)
        .unwrap();
    let Payload::ToolCallStarted { input, .. } = &events[0].payload else {
        panic!("missing card")
    };
    assert_eq!(input["lineText"].as_str().unwrap().lines().count(), 20);
    assert_eq!(input["quotedLineCount"], 30);
    assert_eq!(input["quoteTruncated"], true);
    assert!(!serde_json::to_string(&events[1])
        .unwrap()
        .contains("line 0"));
    assert_eq!(
        agent_name("\n  Reviewer\t\u{1b} agent \r\n"),
        "Reviewer agent"
    );
    assert_eq!(agent_name(&"a".repeat(100)).len(), 80);
}

#[test]
fn retries_return_the_original_note_without_duplicating_notes_or_cards() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\nsecond\nthird").unwrap();
    let session = session(root.path());
    let (service, _) = headless_service();
    let request = params(&session);
    let first = service
        .execute("review.comment", request.clone(), "first")
        .unwrap();
    let mut different = request.clone();
    different["body"] = json!("Another finding");
    service
        .execute("review.comment", different, "second")
        .unwrap();
    let retry = service.execute("review.comment", request, "retry").unwrap();
    assert_eq!(first["created"], true);
    assert_eq!(retry["created"], false);
    assert_eq!(retry["comment"], first["comment"]);
    assert_eq!(
        service
            .manager
            .load_events(&session.id, &session.tabs[0].id)
            .unwrap()
            .len(),
        4
    );
    let comments = service
        .execute("review.comments", params(&session), "list")
        .unwrap();
    assert_eq!(comments["comments"].as_array().unwrap().len(), 2);
    assert_eq!(
        first["comment"]["base"],
        crate::git::head_tree(root.path()).unwrap()
    );
    assert_eq!(
        first["comment"]["reviewedCommit"],
        crate::git::head_commit(root.path()).unwrap()
    );
    assert_eq!(first["comment"]["contextBefore"], json!(["first"]));
}

#[test]
fn concurrent_retries_share_the_store_transaction() {
    let root = tempfile::tempdir().unwrap();
    let gate = Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2).map(|_| {
        let gate = gate.clone();
        let root = root.path().to_owned();
        std::thread::spawn(move || {
            let anchor = serde_json::from_value(json!({"path": "foo.ts", "side": "after", "startLine": 2, "endLine": 2, "lineText": "second", "base": "a".repeat(40)})).unwrap();
            let author = Author { kind: AuthorKind::Agent, session_id: Some("session".into()), tab_id: Some("reviewer".into()), ..Default::default() };
            gate.wait();
            review_comments::save_reviewer(&root, "workspace", anchor, "finding".into(), author, &"b".repeat(40)).unwrap()
        })
    }).collect();
    let saved: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(saved[0].0.id, saved[1].0.id);
    assert_eq!(saved.iter().filter(|(_, created)| *created).count(), 1);
}

#[test]
fn refuses_lines_that_no_longer_describe_the_reviewed_commit() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\nsecond\nthird").unwrap();
    let session = session(root.path());
    let (service, _) = headless_service();
    std::fs::write(root.path().join("foo.ts"), "first\nchanged\nthird").unwrap();
    assert!(service
        .execute("review.comment", params(&session), "dirty")
        .unwrap_err()
        .message
        .contains("changed since"));
    crate::git::run(
        root.path(),
        &[
            "-c",
            "user.name=Reviewer Test",
            "-c",
            "user.email=review@example.com",
            "commit",
            "-am",
            "changed",
        ],
    )
    .unwrap();
    assert!(service
        .execute("review.comment", params(&session), "moved")
        .unwrap_err()
        .message
        .contains("checkout moved"));
    assert!(service
        .manager
        .load_events(&session.id, &session.tabs[0].id)
        .unwrap()
        .is_empty());
}

#[test]
fn branch_comments_use_the_pr_comparison_tree_and_renamed_path() {
    let _home = crate::store::temp_home();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("foo.ts"), "first\nsecond\nthird").unwrap();
    let session = session(root.path());
    let base = crate::git::head_tree(root.path()).unwrap();
    crate::git::run(root.path(), &["checkout", "-b", "feature"]).unwrap();
    crate::git::run(root.path(), &["mv", "foo.ts", "renamed.ts"]).unwrap();
    crate::git::run(
        root.path(),
        &[
            "-c",
            "user.name=Reviewer Test",
            "-c",
            "user.email=review@example.com",
            "commit",
            "-m",
            "rename",
        ],
    )
    .unwrap();
    let mut pipeline = crate::issue_pipeline::store::get(&session.id).unwrap();
    pipeline.review_commit = crate::git::head_commit(root.path());
    crate::issue_pipeline::store::commit(&mut pipeline).unwrap();
    let (service, _) = headless_service();
    let mut request = params(&session);
    request["file"] = json!("renamed.ts");
    let saved = service
        .execute("review.comment", request, "rename")
        .unwrap();
    assert_eq!(saved["comment"]["base"], base);
    assert_ne!(
        saved["comment"]["base"],
        crate::git::head_tree(root.path()).unwrap()
    );
    assert_eq!(saved["comment"]["originalPath"], "foo.ts");
    assert_eq!(saved["comment"]["path"], "renamed.ts");
    assert_eq!(
        saved["comment"]["reviewedCommit"],
        pipeline.review_commit.unwrap()
    );
}
