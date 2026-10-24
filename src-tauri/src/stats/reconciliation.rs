//! Sanitized, generated protocol records. Expected totals are arithmetic here,
//! independent of the production parser, delta resolver, and price functions.
use super::*;
use serde_json::json;

fn write_rows(path: &Path, rows: &[Value], spaced: bool) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text = rows
        .iter()
        .map(|row| {
            let compact = serde_json::to_string(row).unwrap();
            if spaced {
                compact.replace("\":", "\" : ").replace(",\"", ", \"")
            } else {
                compact
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, format!("{text}\n")).unwrap();
}

fn claude_row(cwd: &Path, timestamp: &str, id: &str, output: u64) -> Value {
    json!({"type":"assistant", "sessionId":"claude", "cwd":cwd,
    "timestamp":timestamp, "requestId":id,
    "message":{"id":id, "model":"claude-opus-5", "usage":{
        "input_tokens":2, "output_tokens":output, "cache_read_input_tokens":20,
        "cache_creation_input_tokens":3,
        "cache_creation":{"ephemeral_5m_input_tokens":1, "ephemeral_1h_input_tokens":2}
    }}})
}

fn counts(input: u64, cached: u64, output: u64, reasoning: u64) -> Value {
    json!({"input_tokens":input, "cached_input_tokens":cached, "output_tokens":output,
        "reasoning_output_tokens":reasoning, "total_tokens":input + output})
}

fn token_row(timestamp: &str, total: Value, last: Value) -> Value {
    json!({"type":"event_msg", "timestamp":timestamp,
        "payload":{"type":"token_count", "info":{"total_token_usage":total,"last_token_usage":last}}})
}

#[test]
fn mixed_projects_recover_claude_and_refresh_without_double_counting() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    let ordinary = dir.path().join("ordinary");
    let missing = dir.path().join("removed");
    fs::create_dir(&repo).unwrap();
    fs::create_dir(&ordinary).unwrap();
    crate::git::run(&repo, &["init"]).unwrap();
    let projects = [repo, ordinary.clone(), missing.clone()];
    let scope = project_usage_scope(projects.clone());
    assert!(scope.warnings.is_empty());
    for path in &projects {
        assert!(scope.contains(path.to_str()));
    }

    let store = dir.path().join("store");
    fs::create_dir(&store).unwrap();
    let home = dir.path().join("empty-home");
    let claude_home = dir.path().join("configured-claude");
    let codex_home = dir.path().join("configured-codex");
    let transcript = claude_home.join("projects/session.jsonl");
    let now = Local::now().to_rfc3339();
    write_rows(
        &transcript,
        &[claude_row(&ordinary, &now, "request", 4)],
        true,
    );
    let sources =
        || discover_sources_with_homes(&home, &store, None, Some(&claude_home), Some(&codex_home));
    let inputs = || Ok((AppStats::default(), project_usage_scope(projects.clone())));
    let baseline = scan_snapshot_with(&store, sources, inputs).unwrap();
    assert_eq!(baseline.providers[0].total_tokens, 29);
    write_rows(
        &transcript,
        &[
            claude_row(&ordinary, &now, "request", 4),
            claude_row(&ordinary, &now, "request", 9),
            claude_row(&missing, &now, "removed-location", 9),
        ],
        true,
    );
    for _ in 0..2 {
        let refreshed = scan_snapshot_with(&store, sources, inputs).unwrap();
        assert_eq!(refreshed.providers[0].total_tokens, 68);
        // Each: 2*5 + 9*25 + 20*.5 + 1*6.25 + 2*10 = 271.25 / million.
        assert!((refreshed.estimated_cost_usd.unwrap() - 0.0005425).abs() < 1e-12);
        assert!(!refreshed.has_partial_cost);
    }
    // Remembered locations survive removal from the registry/session index.
    let remembered = scan_snapshot_with(&store, sources, || {
        Ok((AppStats::default(), UsageScope::default()))
    })
    .unwrap();
    assert_eq!(remembered.total_tokens, 68);

    let broken = dir.path().join("not-a-directory");
    fs::write(&broken, "fixture").unwrap();
    let partial = scan_snapshot_with(&store, sources, || {
        Ok((
            AppStats::default(),
            project_usage_scope([ordinary.clone(), broken.clone()]),
        ))
    })
    .unwrap();
    assert_eq!(partial.total_tokens, 68);
    assert_eq!(partial.discovery_warnings.len(), 1);
    assert!(partial.discovery_warnings[0].contains("Could not discover worktrees"));
}

#[test]
fn codex_whitespace_resumes_forks_model_switches_and_resets_reconcile() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let base = Local::now() - chrono::Duration::seconds(10);
    let timestamp = |second| (base + chrono::Duration::seconds(second)).to_rfc3339();
    let first = token_row(
        &timestamp(1),
        counts(100, 80, 25, 10),
        counts(100, 80, 25, 10),
    );
    let rows = vec![
        json!({"type":"session_meta","payload":{"id":"parent","cwd":cwd}}),
        json!({"type":"turn_context","payload":{"model":"gpt-6-astra"}}),
        first.clone(),
        first.clone(),
        json!({"type":"turn_context","payload":{"model":"unmapped-model"}}),
        token_row(
            &timestamp(2),
            counts(160, 100, 40, 15),
            counts(60, 20, 15, 5),
        ),
        first, // Replay after later usage must not rewind the delta baseline.
        token_row(&timestamp(3), counts(20, 10, 5, 2), counts(20, 10, 5, 2)),
        json!({"type":"turn_context","payload":{"model":"gpt-5.4"}}),
        token_row(&timestamp(4), counts(50, 20, 15, 5), counts(30, 10, 10, 3)),
        token_row(&timestamp(5), counts(70, 30, 20, 7), Value::Null),
        token_row(&timestamp(6), counts(5, 2, 2, 1), Value::Null),
        // A gap contains several requests: count the full delta but don't
        // pretend its sum is one request when choosing long-context prices.
        token_row(&timestamp(7), counts(45, 12, 12, 5), counts(10, 2, 3, 1)),
    ];
    let compact = dir.path().join("compact.jsonl");
    let spaced = dir.path().join("spaced.jsonl");
    write_rows(&compact, &rows, false);
    let mut fork = rows.clone();
    fork[0]["payload"]["id"] = json!("fork");
    write_rows(&spaced, &fork, true);
    let parsed = parse_codex(&compact).unwrap();
    assert_eq!(parsed.len(), 7);
    assert_eq!(parsed.iter().map(|e| e.total_tokens).sum::<u64>(), 347);
    let files = [compact, spaced].map(|path| CachedFile {
        events: parse_codex(&path).unwrap(),
        path,
        provider: Provider::Codex,
        modified_nanos: 1,
        size: 1,
    });
    let snapshot = aggregate(
        &files,
        AppStats::default(),
        &UsageScope::from_paths([cwd]),
        &overview_cutoff(Local::now()),
    );
    assert_eq!(snapshot.total_tokens, 347);
    assert_eq!(snapshot.new_input_tokens, 133);
    assert_eq!(snapshot.cache_tokens, 142);
    assert_eq!(snapshot.output_tokens, 72);
    assert_eq!(snapshot.reasoning_tokens, 27); // A subset of output, not added again.
    assert_eq!(snapshot.providers[1].activity_count, 7);
    assert!(snapshot.has_partial_cost);
    // Astra: (20*10 + 80*1 + 25*50); 5.4: (20*2.5 + 10*.25 + 10*15).
    assert!((snapshot.estimated_cost_usd.unwrap() - 0.0017325).abs() < 1e-12);
    assert!(snapshot.providers[1]
        .unpriced_models
        .contains(&"unmapped-model".into()));
}

#[test]
fn archived_and_deleted_transcripts_preserve_recorded_usage_and_lifetime_activity() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let store = dir.path().join("store");
    fs::create_dir(&store).unwrap();
    let cwd = dir.path().join("removed-worktree");
    let source = home.join(".codex/sessions/rollout.jsonl");
    let archive = home.join(".codex/archived_sessions/rollout.jsonl");
    write_rows(
        &source,
        &[
            json!({"type":"session_meta","payload":{"id":"session","cwd":cwd}}),
            json!({"type":"turn_context","payload":{"model":"gpt-6-astra"}}),
            token_row(
                &Local::now().to_rfc3339(),
                counts(100, 80, 25, 10),
                counts(100, 80, 25, 10),
            ),
        ],
        false,
    );
    let sources = || discover_sources_at(&home, &store, None);
    let inputs = || {
        Ok((
            AppStats {
                agents_spawned: 3,
                agent_time_ms: 1000,
                prs_created: 2,
                ..Default::default()
            },
            UsageScope::from_paths([cwd.clone()]),
        ))
    };
    let baseline = scan_snapshot_with(&store, sources, inputs).unwrap();
    fs::create_dir_all(archive.parent().unwrap()).unwrap();
    fs::rename(&source, &archive).unwrap();
    let archived = scan_snapshot_with(&store, sources, inputs).unwrap();
    assert_eq!(baseline.total_tokens, 125);
    assert_eq!(archived.total_tokens, 125);
    fs::remove_file(archive).unwrap();
    let deleted = scan_snapshot_with(&store, sources, inputs).unwrap();
    assert_eq!(deleted.total_tokens, 125);
    // Reloading the on-disk projection after a restart retains the same totals.
    let restarted = scan_snapshot_with(&store, sources, inputs).unwrap();
    assert_eq!(restarted.total_tokens, 125);
    assert_eq!(deleted.app.agents_spawned, 3);
    assert_eq!(deleted.app.prs_created, 2);
}

#[test]
fn unknown_prices_and_nonstandard_tiers_are_not_zero_dollars() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let path = dir.path().join("claude.jsonl");
    let mut unknown = claude_row(&cwd, &Local::now().to_rfc3339(), "unknown", 9);
    unknown["message"]["model"] = json!("claude-opus-5-unknown");
    let mut fast = claude_row(&cwd, &Local::now().to_rfc3339(), "fast", 9);
    fast["message"]["usage"]["service_tier"] = json!("fast");
    write_rows(&path, &[unknown, fast], true);
    let file = CachedFile {
        events: parse_claude(&path).unwrap(),
        path,
        provider: Provider::Claude,
        modified_nanos: 1,
        size: 1,
    };
    let snapshot = aggregate(
        &[file],
        AppStats::default(),
        &UsageScope::from_paths([cwd]),
        &overview_cutoff(Local::now()),
    );
    assert_eq!(snapshot.total_tokens, 68);
    assert!(snapshot.has_partial_cost);
    assert_eq!(snapshot.estimated_cost_usd, None);
}

#[test]
fn local_midnight_and_cutoff_use_local_calendar_dates() {
    use chrono::TimeZone;
    let reference = Local
        .with_ymd_and_hms(2026, 9, 3, 12, 0, 0)
        .single()
        .unwrap();
    let midnight = Local
        .with_ymd_and_hms(2026, 8, 5, 0, 0, 0)
        .single()
        .unwrap();
    assert_eq!(overview_cutoff(reference), "2026-08-05");
    assert_eq!(time_parts(&midnight.to_rfc3339()).unwrap().1, "2026-08-05");
    assert_eq!(
        time_parts(&(midnight - chrono::Duration::seconds(1)).to_rfc3339())
            .unwrap()
            .1,
        "2026-08-04"
    );
}

#[test]
fn configured_homes_and_standard_homes_are_discovered_once() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let store = dir.path().join("store");
    let claude = dir.path().join("claude-config");
    let codex = dir.path().join("codex-config");
    for path in [
        home.join(".claude/projects/default.jsonl"),
        home.join(".codex/sessions/default.jsonl"),
        claude.join("projects/configured.jsonl"),
        claude.join("transcripts/configured.jsonl"),
        codex.join("sessions/configured.jsonl"),
        codex.join("archived_sessions/archived.jsonl"),
    ] {
        write_rows(&path, &[], false);
    }
    let sources =
        discover_sources_with_homes(&home, &store, None, Some(&claude), Some(&codex)).unwrap();
    assert_eq!(sources.len(), 6);
    let overlapping = discover_sources_with_homes(
        &home,
        &store,
        None,
        Some(&home.join(".claude")),
        Some(&home.join(".codex")),
    )
    .unwrap();
    assert_eq!(overlapping.len(), 2);
}

#[test]
fn a_small_counter_reset_is_not_discarded_as_a_stale_sample() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("reset.jsonl");
    write_rows(
        &path,
        &[
            token_row(
                "2026-09-03T12:00:00Z",
                counts(50, 20, 10, 2),
                counts(50, 20, 10, 2),
            ),
            token_row(
                "2026-09-03T12:00:01Z",
                counts(45, 20, 10, 2),
                counts(45, 20, 10, 2),
            ),
            token_row(
                "2026-09-03T12:00:02Z",
                counts(50, 22, 12, 3),
                counts(5, 2, 2, 1),
            ),
        ],
        true,
    );
    let events = parse_codex(&path).unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events.iter().map(|event| event.total_tokens).sum::<u64>(),
        122
    );
}

#[test]
fn malformed_accounting_cache_is_visible_and_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CACHE_FILE);
    fs::write(&path, "invalid fixture").unwrap();
    assert!(scan_snapshot_with(
        dir.path(),
        || Ok(vec![]),
        || Ok((AppStats::default(), UsageScope::default()))
    )
    .is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "invalid fixture");
}

#[test]
fn upgraded_cache_reparses_existing_files_and_retains_deleted_projections() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let path = dir.path().join("claude.jsonl");
    write_rows(
        &path,
        &[claude_row(&cwd, &Local::now().to_rfc3339(), "one", 9)],
        false,
    );
    let sources = || Ok(vec![(path.clone(), Provider::Claude)]);
    let inputs = || Ok((AppStats::default(), UsageScope::from_paths([cwd.clone()])));
    scan_snapshot_with(dir.path(), sources, inputs).unwrap();
    let cache_path = dir.path().join(CACHE_FILE);
    let mut old: Value = serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
    old["schemaVersion"] = json!(3);
    old["files"][0]["events"][0]
        .as_object_mut()
        .unwrap()
        .remove("cacheWriteHourTokens");
    fs::write(&cache_path, serde_json::to_vec(&old).unwrap()).unwrap();
    let upgraded = scan_snapshot_with(dir.path(), sources, inputs).unwrap();
    assert!((upgraded.estimated_cost_usd.unwrap() - 0.00027125).abs() < 1e-12);
    // Retain a request even if a provider rewrites the file to a suffix.
    write_rows(
        &path,
        &[claude_row(&cwd, &Local::now().to_rfc3339(), "two", 9)],
        false,
    );
    let rewritten = scan_snapshot_with(dir.path(), sources, inputs).unwrap();
    assert_eq!(rewritten.total_tokens, 68);
    fs::remove_file(path).unwrap();
    let deleted = scan_snapshot_with(dir.path(), || Ok(vec![]), inputs).unwrap();
    assert_eq!(deleted.total_tokens, 68);
}

#[test]
fn future_records_are_outside_the_thirty_date_overview() {
    use chrono::TimeZone;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("claude.jsonl");
    let cwd = dir.path().join("project");
    let reference = Local
        .with_ymd_and_hms(2026, 9, 3, 12, 0, 0)
        .single()
        .unwrap();
    let cutoff = reference - chrono::Duration::days(29);
    write_rows(
        &path,
        &[
            claude_row(
                &cwd,
                &(cutoff - chrono::Duration::days(1)).to_rfc3339(),
                "too-old",
                9,
            ),
            claude_row(&cwd, &cutoff.to_rfc3339(), "first-date", 9),
            claude_row(&cwd, &reference.to_rfc3339(), "today", 9),
            claude_row(
                &cwd,
                &(reference + chrono::Duration::days(1)).to_rfc3339(),
                "future",
                9,
            ),
        ],
        false,
    );
    let file = CachedFile {
        events: parse_claude(&path).unwrap(),
        path,
        provider: Provider::Claude,
        size: 1,
        modified_nanos: 1,
    };
    let snapshot = aggregate(
        &[file],
        AppStats::default(),
        &UsageScope::from_paths([cwd]),
        &overview_cutoff(reference),
    );
    assert_eq!(snapshot.total_tokens, 68);
    assert_eq!(snapshot.providers[0].sessions, 1);
    assert_eq!(snapshot.range_start, "2026-08-05");
    assert_eq!(snapshot.range_end, "2026-09-03");
}

#[test]
fn claude_copied_stream_prefix_does_not_hide_the_final_usage() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let timestamp = Local::now().to_rfc3339();
    let paths = [
        dir.path().join("prefix.jsonl"),
        dir.path().join("fork.jsonl"),
    ];
    write_rows(
        &paths[0],
        &[claude_row(&cwd, &timestamp, "shared-request", 4)],
        false,
    );
    let mut final_row = claude_row(&cwd, &timestamp, "shared-request", 9);
    final_row["sessionId"] = json!("fork");
    write_rows(&paths[1], &[final_row], true);
    let files = paths.map(|path| CachedFile {
        events: parse_claude(&path).unwrap(),
        path,
        provider: Provider::Claude,
        size: 1,
        modified_nanos: 1,
    });
    for ordered in [files.to_vec(), files.into_iter().rev().collect()] {
        let snapshot = aggregate(
            &ordered,
            AppStats::default(),
            &UsageScope::from_paths([cwd.clone()]),
            &overview_cutoff(Local::now()),
        );
        assert_eq!(snapshot.total_tokens, 34);
        assert_eq!(snapshot.providers[0].activity_count, 1);
        assert!((snapshot.estimated_cost_usd.unwrap() - 0.00027125).abs() < 1e-12);
    }
}

#[test]
fn resumed_codex_baseline_does_not_rebill_unobserved_prior_requests() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("resumed.jsonl");
    write_rows(
        &path,
        &[
            json!({"type":"session_meta","payload":{"id":"resumed","cwd":"/fixture"}}),
            json!({"type":"turn_context","payload":{"model":"gpt-6-astra","service_tier":"fast"}}),
            token_row(
                "2026-09-03T12:00:00Z",
                counts(1000, 800, 250, 100),
                counts(100, 80, 25, 10),
            ),
            json!({"type":"turn_context","payload":{"model":"gpt-6-astra","service_tier":"default"}}),
            token_row(
                "2026-09-03T12:00:01Z",
                counts(1200, 900, 300, 120),
                counts(200, 100, 50, 20),
            ),
        ],
        true,
    );
    let events = parse_codex(&path).unwrap();
    assert_eq!(
        events.iter().map(|event| event.total_tokens).sum::<u64>(),
        375
    );
    assert_eq!(
        events.iter().map(|event| event.cache_tokens).sum::<u64>(),
        180
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.new_input_tokens)
            .sum::<u64>(),
        120
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.reasoning_tokens)
            .sum::<u64>(),
        30
    );
    assert!(events[0].unpriced, "unsupported tier is explicitly omitted");
    assert!(
        !events[1].unpriced,
        "returning to standard tier restores request pricing"
    );
}

#[test]
fn zero_counter_reset_updates_the_baseline_without_emitting_usage() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("zero-reset.jsonl");
    write_rows(
        &path,
        &[
            token_row("2026-09-03T12:00:00Z", counts(100, 0, 0, 0), Value::Null),
            token_row("2026-09-03T12:00:01Z", counts(0, 0, 0, 0), Value::Null),
            token_row("2026-09-03T12:00:02Z", counts(150, 0, 0, 0), Value::Null),
        ],
        true,
    );
    let events = parse_codex(&path).unwrap();
    assert_eq!(
        events
            .iter()
            .map(|event| event.total_tokens)
            .collect::<Vec<_>>(),
        vec![100, 150]
    );
    assert_eq!(
        events
            .iter()
            .map(|event| event.new_input_tokens)
            .sum::<u64>(),
        250
    );
}

#[test]
fn unreparsed_legacy_records_keep_tokens_but_remain_unpriced_after_upgrade() {
    for deleted in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("project");
        let path = dir.path().join("claude.jsonl");
        let timestamp = Local::now().to_rfc3339();
        let mut fast = claude_row(&cwd, &timestamp, "fast", 9);
        fast["message"]["usage"]["service_tier"] = json!("fast");
        let standard = claude_row(&cwd, &timestamp, "standard", 9);
        write_rows(&path, &[fast, standard.clone()], false);
        let sources = || {
            if deleted {
                Ok(vec![])
            } else {
                Ok(vec![(path.clone(), Provider::Claude)])
            }
        };
        let inputs = || Ok((AppStats::default(), UsageScope::from_paths([cwd.clone()])));
        scan_snapshot_with(
            dir.path(),
            || Ok(vec![(path.clone(), Provider::Claude)]),
            inputs,
        )
        .unwrap();
        let cache_path = dir.path().join(CACHE_FILE);
        let mut legacy: Value = serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
        legacy["schemaVersion"] = json!(3);
        for event in legacy["files"][0]["events"].as_array_mut().unwrap() {
            let event = event.as_object_mut().unwrap();
            event.remove("unpriced");
            event.remove("cacheWriteHourTokens");
        }
        fs::write(&cache_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        if deleted {
            fs::remove_file(&path).unwrap();
        } else {
            // The missing prefix has the same uncertainty as a deleted file.
            write_rows(&path, &[standard], false);
        }
        for _ in 0..2 {
            let snapshot = scan_snapshot_with(dir.path(), sources, inputs).unwrap();
            assert_eq!(snapshot.total_tokens, 68);
            assert!(snapshot.has_partial_cost);
            assert!(snapshot.providers[0].has_partial_cost);
            if deleted {
                assert_eq!(snapshot.estimated_cost_usd, None);
            } else {
                assert!((snapshot.estimated_cost_usd.unwrap() - 0.00027125).abs() < 1e-12);
            }
        }
        let upgraded: ScanCache = crate::store::read_json(&cache_path).unwrap().unwrap();
        assert_eq!(upgraded.schema_version, CACHE_SCHEMA);
        assert_eq!(
            upgraded.files[0]
                .events
                .iter()
                .filter(|event| event.unpriced)
                .count(),
            if deleted { 2 } else { 1 }
        );
    }
}

#[test]
fn both_providers_keep_prompt_free_accounting_after_shared_histories_are_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let store = dir.path().join("store");
    fs::create_dir(&store).unwrap();
    let cwd = dir.path().join("removed-worktree");
    let claude = dir.path().join("claude.jsonl");
    let codex = dir.path().join("codex.jsonl");
    let copy = dir.path().join("claude-fork.jsonl");
    let timestamp = Local::now().to_rfc3339();
    let mut row = claude_row(&cwd, &timestamp, "shared-request", 9);
    row["message"]["content"] = json!([{"type":"text","text":"PRIVATE_PROMPT_SENTINEL"}]);
    write_rows(&claude, &[row], false);
    fs::copy(&claude, &copy).unwrap();
    write_rows(
        &codex,
        &[
            json!({"type":"session_meta","payload":{"id":"codex","cwd":cwd}}),
            json!({"type":"turn_context","payload":{"model":"gpt-6-astra"}}),
            token_row(&timestamp, counts(100, 80, 25, 10), counts(100, 80, 25, 10)),
        ],
        false,
    );
    let inputs = || Ok((AppStats::default(), UsageScope::from_paths([cwd.clone()])));
    let baseline = scan_snapshot_with(
        &store,
        || {
            Ok(vec![
                (claude.clone(), Provider::Claude),
                (copy.clone(), Provider::Claude),
                (codex.clone(), Provider::Codex),
            ])
        },
        inputs,
    )
    .unwrap();
    assert_eq!(baseline.total_tokens, 159);
    assert!(baseline.estimated_cost_usd.unwrap() > 0.0);
    for path in [&claude, &copy, &codex] {
        fs::remove_file(path).unwrap();
    }
    // Every call reloads the durable projection, as a fresh process does.
    for _ in 0..2 {
        let restored = scan_snapshot_with(&store, || Ok(vec![]), inputs).unwrap();
        assert_eq!(restored.total_tokens, baseline.total_tokens);
        assert_eq!(restored.estimated_cost_usd, baseline.estimated_cost_usd);
        assert_eq!(restored.providers[0].activity_count, 1);
        assert_eq!(restored.providers[1].activity_count, 1);
    }
    assert!(!fs::read_to_string(store.join(CACHE_FILE))
        .unwrap()
        .contains("PRIVATE_PROMPT_SENTINEL"));
    // A shared history restored later is still the same recorded request.
    write_rows(
        &copy,
        &[claude_row(&cwd, &timestamp, "shared-request", 9)],
        false,
    );
    let restored = scan_snapshot_with(
        &store,
        || Ok(vec![(copy.clone(), Provider::Claude)]),
        inputs,
    )
    .unwrap();
    assert_eq!(restored.total_tokens, baseline.total_tokens);
}
