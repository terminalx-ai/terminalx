//! What a diff touches, as far as two questions go: does the reviewer owe a
//! security pass, and is this a kind of change the project always wants a
//! person to merge.
//!
//! Both are read from the changed paths and the added lines, deliberately on
//! the generous side. A false alarm costs one extra pass or one click on
//! Merge; a miss merges a migration nobody looked at.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use super::gate::ProtectedHit;
use crate::store::projects::ProtectedCategories;
use super::verdict::Verdict;

fn lower(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|segment| !segment.is_empty()).collect()
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn is_migration(path: &str) -> bool {
    let path = lower(path);
    let name = file_name(&path);
    segments(&path).iter().any(|segment| matches!(*segment, "migrations" | "migration" | "migrate" | "drizzle" | "alembic" | "flyway" | "liquibase"))
        || name.ends_with(".sql")
        || matches!(name, "schema.prisma" | "schema.rb" | "structure.sql")
}

fn is_deploy_config(path: &str) -> bool {
    let path = lower(path);
    let name = file_name(&path);
    let parts = segments(&path);
    path.starts_with(".github/workflows/")
        || path.starts_with(".circleci/")
        || path.starts_with(".buildkite/")
        || parts.iter().any(|segment| matches!(*segment, "terraform" | "k8s" | "kubernetes" | "helm" | "charts" | "deploy" | "deployment" | "deployments" | "infra" | "infrastructure" | "ansible" | "pulumi"))
        || name == "dockerfile"
        || name.starts_with("dockerfile.")
        || name.ends_with(".dockerfile")
        || name.starts_with("docker-compose")
        || name.starts_with("compose.") && (name.ends_with(".yml") || name.ends_with(".yaml"))
        || name.ends_with(".tf")
        || name.ends_with(".tfvars")
        || matches!(
            name,
            "fly.toml" | "vercel.json" | "netlify.toml" | "render.yaml" | "render.yml" | "wrangler.toml" | "wrangler.json" | "wrangler.jsonc" | "procfile" | "app.yaml" | "cloudbuild.yaml"
                | "serverless.yml" | "serverless.yaml" | ".gitlab-ci.yml" | "jenkinsfile" | "azure-pipelines.yml" | "skaffold.yaml" | "railway.json" | "railway.toml" | "heroku.yml"
        )
}

/// The project's own patterns, matched the way Git matches an ignore file.
fn custom_matches(patterns: &[String], paths: &[String]) -> Vec<String> {
    let mut builder = ignore::gitignore::GitignoreBuilder::new("/");
    let mut any = false;
    for pattern in patterns.iter().map(|pattern| pattern.trim()).filter(|pattern| !pattern.is_empty() && !pattern.starts_with('#')) {
        any |= builder.add_line(None, pattern).is_ok();
    }
    let Some(matcher) = any.then(|| builder.build().ok()).flatten() else {
        return Vec::new();
    };
    paths.iter().filter(|path| matcher.matched_path_or_any_parents(Path::new("/").join(path), false).is_ignore()).cloned().collect()
}

fn hit(category: &str, mut evidence: Vec<String>) -> Option<ProtectedHit> {
    evidence.sort();
    evidence.dedup();
    (!evidence.is_empty()).then(|| ProtectedHit { category: category.into(), evidence })
}

/// The protected categories this change falls in. `verdict` is the review of
/// the same commit the paths were read at.
pub fn protected_hits(categories: &ProtectedCategories, changed_paths: &[String], verdict: Option<&Verdict>) -> Vec<ProtectedHit> {
    let matching = |test: fn(&str) -> bool| changed_paths.iter().filter(|path| test(path)).cloned().collect::<Vec<_>>();
    let mut hits = Vec::new();
    if categories.migrations {
        hits.extend(hit("migrations", matching(is_migration)));
    }
    if categories.deploy {
        hits.extend(hit("deploy", matching(is_deploy_config)));
    }
    if categories.security {
        if let Some(verdict) = verdict.filter(|verdict| verdict.security_flagged()) {
            let flagged: Vec<String> = verdict.findings.iter().filter(|finding| finding.security).map(|finding| finding.title.clone()).collect();
            hits.extend(hit("security", if flagged.is_empty() { vec!["The security pass flagged this change.".into()] } else { flagged }));
        }
    }
    hits.extend(hit("paths", custom_matches(&categories.paths, changed_paths)));
    hits
}

struct Area {
    name: &'static str,
    /// Words in a changed path.
    path: &'static str,
    /// Words in an added line.
    line: &'static str,
}

/// The five areas the issue names. Both lists are matched as whole words of
/// text put through [`words`], so `checkPermissions`, `check_permissions` and
/// `permissions.ts` all carry the word `permissions`.
const AREAS: [Area; 5] = [
    Area {
        name: "authorization",
        path: "auth|authn|authz|authorization|authentication|login|logout|sign_?in|sign_?up|session|sessions|permission|permissions|rbac|acl|role|roles|policy|policies|oauth|sso|saml|jwt|password|passwords|grant|grants|guard|guards|middleware|credential|credentials",
        line: "authoriz[a-z]*|authentic[a-z]*|unauthori[a-z]*|forbidden|permission|permissions|is_admin|is_owner|has_role|require_role|access_token|refresh_token|bearer|jwt|oauth|csrf|set[-_]cookie|password|passwd",
    },
    Area {
        name: "secrets",
        path: "secret|secrets|credential|credentials|keychain|vault|token|tokens|api_?key|api_?keys|env|kms|encrypt[a-z]*|decrypt[a-z]*|crypto",
        line: "secret|secrets|api[-_]?key|private[-_]?key|client[-_]?secret|signing[-_]?key|encrypt[a-z]*|decrypt[a-z]*|keychain|begin [a-z ]*private key",
    },
    Area {
        name: "billing",
        path: "billing|payment|payments|invoice|invoices|subscription|subscriptions|stripe|checkout|pricing|charge|charges|refund|refunds|paddle|entitlement|entitlements|metering|quota|quotas",
        line: "billing|invoice[a-z]*|subscription[a-z]*|stripe|charge[a-z]*|refund[a-z]*|payment[a-z]*|price_id|entitlement[a-z]*",
    },
    Area {
        name: "deletion",
        path: "delete|deletes|deletion|remove|removal|purge|cleanup|clean_up|destroy|retention|gc|prune",
        line: r"delete from|drop (?:table|column|database|index|schema)|truncate|rm -[a-z]*r[a-z]*|remove_dir_all|rmtree|unlink[a-z_]*|remove_file|rm_sync|destroy[a-z_]*|purge[a-z_]*|delete_object|delete_branch|rimraf|branch -d|push [^\n]*--delete",
    },
    Area {
        name: "connection handling",
        path: "connection|connections|socket|sockets|web_?socket|web_?sockets|relay|tls|ssl|proxy|cors|transport|tunnel|rpc|pairing|handshake|listener|network|net|http|https",
        line: r"tcp_?listener|tcp_?stream|unix_?listener|web_?socket[a-z_]*|tls[a-z_]*|certificate[a-z]*|danger_accept_invalid_certs|reject_unauthorized|verify ?= ?false|access-control-allow-origin|cors|create_server|handshake[a-z]*|0\.0\.0\.0",
    },
];

/// Text as lower-case words: a capital after a small letter starts a new
/// word, so camelCase and snake_case read alike.
fn words(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let mut previous = ' ';
    for ch in text.chars() {
        if ch.is_ascii_uppercase() && (previous.is_ascii_lowercase() || previous.is_ascii_digit()) {
            out.push('_');
        }
        out.push(ch.to_ascii_lowercase());
        previous = ch;
    }
    out
}

fn area_patterns() -> &'static Vec<(Regex, Regex)> {
    static PATTERNS: OnceLock<Vec<(Regex, Regex)>> = OnceLock::new();
    // A word stands between things that are not letters or digits: `auth.rs`
    // and `src/auth/` count, `author.rs` does not.
    let whole = |alternatives: &str| Regex::new(&format!(r"(?:^|[^a-z0-9])(?:{alternatives})(?:[^a-z0-9]|$)")).expect("area pattern");
    PATTERNS.get_or_init(|| AREAS.iter().map(|area| (whole(area.path), whole(area.line))).collect())
}

/// Tests, fixtures and prose change the same words without changing what the
/// program does with them.
fn is_documentation(path: &str) -> bool {
    let path = lower(path);
    path.ends_with(".md") || path.ends_with(".mdx") || path.ends_with(".txt") || path.ends_with(".rst") || path.starts_with("docs/") || file_name(&path) == "changelog"
}

/// The lines a unified diff adds, grouped under the file they belong to.
fn added_lines(diff: &str) -> Vec<(String, String)> {
    let mut file = String::new();
    let mut lines = Vec::new();
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("+++ ") {
            file = path.trim().strip_prefix("b/").unwrap_or(path.trim()).to_string();
        } else if line.starts_with('+') && !line.starts_with("+++") {
            lines.push((file.clone(), words(&line[1..])));
        }
    }
    lines
}

/// The areas a change touches that call for a security pass, by name. Empty
/// when none: the reviewer may still run a pass of its own accord.
pub fn security_areas(changed_paths: &[String], diff: &str) -> Vec<String> {
    let patterns = area_patterns();
    let mut touched = BTreeSet::new();
    let code_paths: Vec<String> = changed_paths.iter().filter(|path| !is_documentation(path)).map(|path| words(&path.replace('\\', "/"))).collect();
    let added: Vec<(String, String)> = added_lines(diff).into_iter().filter(|(file, _)| !is_documentation(file)).collect();
    for (area, (path_pattern, line_pattern)) in AREAS.iter().zip(patterns) {
        if code_paths.iter().any(|path| path_pattern.is_match(path)) || added.iter().any(|(_, line)| line_pattern.is_match(line)) {
            touched.insert(area.name);
        }
    }
    // Reported in the order the issue lists them.
    AREAS.iter().map(|area| area.name).filter(|name| touched.contains(name)).map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue_pipeline::verdict::{Decision, Finding, SecurityPass, Severity};

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn categories_of(hits: &[ProtectedHit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.category.as_str()).collect()
    }

    #[test]
    fn migrations_and_deploy_config_are_protected_by_default() {
        let all = ProtectedCategories::default();
        let hits = protected_hits(&all, &paths(&["saas/drizzle/0042_add_plan.sql", "src/lib/api.ts", ".github/workflows/release.yml", "infra/terraform/main.tf", "Dockerfile"]), None);
        assert_eq!(categories_of(&hits), ["migrations", "deploy"]);
        assert_eq!(hits[0].evidence, ["saas/drizzle/0042_add_plan.sql"]);
        assert_eq!(hits[1].evidence, [".github/workflows/release.yml", "Dockerfile", "infra/terraform/main.tf"]);
        for path in ["db/migrate/20261012_x.rb", "prisma/schema.prisma", "app/Migrations/Version1.php", "schema/structure.sql"] {
            assert_eq!(categories_of(&protected_hits(&all, &paths(&[path]), None)), ["migrations"], "{path}");
        }
        for path in ["fly.toml", "deploy/prod.yaml", "docker-compose.prod.yml", "k8s/api.yaml", "wrangler.toml", "ops/api.Dockerfile", ".circleci/config.yml"] {
            assert_eq!(categories_of(&protected_hits(&all, &paths(&[path]), None)), ["deploy"], "{path}");
        }
        // Ordinary code is in neither, including names that merely resemble one.
        assert!(protected_hits(&all, &paths(&["src/components/issues/IssuesView.tsx", "src/lib/migrationsHelp.ts", "src/deployed.ts", "README.md"]), None).is_empty());
    }

    #[test]
    fn a_category_the_project_turned_off_does_not_hold_a_merge() {
        let none = ProtectedCategories { migrations: false, deploy: false, security: false, paths: Vec::new() };
        let flagged = Verdict { commit: "abc1234".into(), decision: Decision::Merge, security_pass: SecurityPass::Flagged, findings: Vec::new(), round: 1, at: "now".into() };
        assert!(protected_hits(&none, &paths(&["db/migrations/1.sql", "Dockerfile"]), Some(&flagged)).is_empty());
    }

    #[test]
    fn anything_the_security_pass_flagged_is_protected() {
        let all = ProtectedCategories::default();
        let mut verdict = Verdict { commit: "abc1234".into(), decision: Decision::Merge, security_pass: SecurityPass::Clean, findings: Vec::new(), round: 1, at: "now".into() };
        assert!(protected_hits(&all, &paths(&["src/a.rs"]), Some(&verdict)).is_empty());
        verdict.security_pass = SecurityPass::Flagged;
        let hits = protected_hits(&all, &paths(&["src/a.rs"]), Some(&verdict));
        assert_eq!(categories_of(&hits), ["security"]);
        verdict.findings = vec![Finding { severity: Severity::Low, title: "Token lifetime is long".into(), detail: None, file: None, line: None, security: true }];
        assert_eq!(protected_hits(&all, &paths(&["src/a.rs"]), Some(&verdict))[0].evidence, ["Token lifetime is long"]);
    }

    #[test]
    fn a_projects_own_patterns_match_as_gitignore_lines_do() {
        let categories = ProtectedCategories { migrations: false, deploy: false, security: false, paths: vec!["saas/src/billing/".into(), "*.plist".into(), "# a comment".into(), "  ".into(), "/scripts/release.sh".into()] };
        let hits = protected_hits(&categories, &paths(&["saas/src/billing/plans.ts", "src-tauri/Info.plist", "scripts/release.sh", "tools/scripts/release.sh", "src/main.ts"]), None);
        assert_eq!(categories_of(&hits), ["paths"]);
        assert_eq!(hits[0].evidence, ["saas/src/billing/plans.ts", "scripts/release.sh", "src-tauri/Info.plist"]);
    }

    #[test]
    fn the_five_areas_are_found_by_path() {
        for (path, area) in [
            ("src-tauri/src/auth.rs", "authorization"),
            ("saas/src/middleware/session.ts", "authorization"),
            ("src-tauri/src/keychain.rs", "secrets"),
            ("saas/src/billing/plans.ts", "billing"),
            ("src-tauri/src/worktree_cleanup.rs", "deletion"),
            ("src-tauri/src/remote/relay.rs", "connection handling"),
        ] {
            assert!(security_areas(&paths(&[path]), "").contains(&area.to_string()), "{path} should touch {area}");
        }
        // Whole words only, and never prose.
        assert!(security_areas(&paths(&["src/components/AuthorCard.tsx", "src/lib/tokenize.ts", "docs/auth.md", "CHANGELOG.md"]), "").is_empty());
        // camelCase names carry the same words as snake_case ones.
        assert_eq!(security_areas(&paths(&["src/lib/apiKeys.ts"]), ""), ["secrets"]);
        assert_eq!(security_areas(&paths(&["src/AuthService.ts"]), ""), ["authorization"]);
        assert_eq!(words("checkPermissions(TcpListener, HTTPServer2Go)"), "check_permissions(tcp_listener, httpserver2_go)");
    }

    #[test]
    fn the_five_areas_are_found_in_added_lines_only() {
        let diff = "diff --git a/src/store.rs b/src/store.rs\n--- a/src/store.rs\n+++ b/src/store.rs\n@@ -1,3 +1,4 @@\n fn keep() {}\n-    std::fs::remove_dir_all(&old)?;\n+    let rows = db.execute(\"DELETE FROM sessions WHERE user = ?\")?;\n";
        assert_eq!(security_areas(&paths(&["src/store.rs"]), diff), ["deletion"]);
        // A removed line that deleted something is not a new deletion.
        let removed_only = "+++ b/src/store.rs\n-    std::fs::remove_dir_all(&old)?;\n+    let total = rows.len();\n";
        assert!(security_areas(&paths(&["src/store.rs"]), removed_only).is_empty());
        for (line, area) in [
            ("+    if !user.is_admin { return Err(Forbidden) }", "authorization"),
            ("+const API_KEY = process.env.STRIPE_KEY", "secrets"),
            ("+    stripe.subscriptions.update(id, { price_id })", "billing"),
            ("+    fs.rmSync(dir, { recursive: true }); rimraf(dir)", "deletion"),
            ("+    let listener = TcpListener::bind(\"0.0.0.0:8080\")?;", "connection handling"),
        ] {
            let diff = format!("+++ b/src/x.rs\n{line}\n");
            assert!(security_areas(&paths(&["src/x.rs"]), &diff).contains(&area.to_string()), "{line} should touch {area}");
        }
        // The same words in a document are not a change in behaviour.
        assert!(security_areas(&paths(&["docs/notes.md"]), "+++ b/docs/notes.md\n+Rotate the API_KEY and delete from the table.\n").is_empty());
    }

    #[test]
    fn areas_come_back_in_the_order_the_issue_names_them() {
        let diff = "+++ b/src/x.rs\n+    TcpListener::bind(addr)?; // billing\n+    check_permissions(user)?;\n";
        assert_eq!(security_areas(&paths(&["src/x.rs"]), diff), ["authorization", "billing", "connection handling"]);
    }
}
