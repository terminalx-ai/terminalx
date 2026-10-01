//! Every serde enum with a struct variant states how its fields are named.
//!
//! `#[serde(rename_all = "camelCase")]` on an enum renames only the variant
//! tags, never the fields inside a struct variant. That is how
//! `cloud_remote_event` went out with `connection_id` while the web view read
//! `connectionId`, so every opened cloud session stayed "Not connected" (#197).
//!
//! So each such enum must carry `rename_all_fields`: `"camelCase"` for the web
//! view, the API and the portable packages, or `"snake_case"` where snake_case
//! is intended (an external format, or a file already written to disk), with a
//! comment saying why. The source is parsed, not grepped, so formatting and
//! comments cannot hide an enum.

use std::path::{Path, PathBuf};

use syn::visit::Visit;

struct Finder<'a> {
    file: PathBuf,
    source: &'a str,
    missing: Vec<String>,
}

/// The line of `enum <name>` in the source (spans carry no lines outside a
/// proc macro without proc-macro2's span-locations).
fn line_of(source: &str, name: &str) -> usize {
    let needle = format!("enum {name}");
    let at = source
        .match_indices(&needle)
        .find(|(at, _)| !source[at + needle.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_'))
        .map_or(0, |(at, _)| at);
    source[..at].matches('\n').count() + 1
}

fn serde_derived(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().filter(|attr| attr.path().is_ident("derive")).any(|attr| {
        let mut found = false;
        let _ = attr.parse_nested_meta(|meta| {
            if meta.path.segments.last().is_some_and(|segment| segment.ident == "Serialize" || segment.ident == "Deserialize") {
                found = true;
            }
            Ok(())
        });
        found
    })
}

fn names_fields(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().filter(|attr| attr.path().is_ident("serde")).any(|attr| {
        let mut found = false;
        let _ = attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("rename_all_fields") {
                found = true;
            }
            // Skip the value (`= "…"` or `(…)`) so parsing continues.
            if meta.input.peek(syn::Token![=]) {
                meta.value()?.parse::<syn::Expr>()?;
            } else if meta.input.peek(syn::token::Paren) {
                let _ = meta.parse_nested_meta(|_| Ok(()));
            }
            Ok(())
        });
        found
    })
}

impl<'ast> Visit<'ast> for Finder<'_> {
    fn visit_item_enum(&mut self, item: &'ast syn::ItemEnum) {
        let struct_variant = item.variants.iter().any(|variant| matches!(variant.fields, syn::Fields::Named(_)));
        if struct_variant && serde_derived(&item.attrs) && !names_fields(&item.attrs) {
            let line = line_of(self.source, &item.ident.to_string());
            self.missing.push(format!("{}:{line} enum {}", self.file.display(), item.ident));
        }
        syn::visit::visit_item_enum(self, item);
    }
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "target") {
                continue;
            }
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Every enum found in `source` that needs a field-naming decision and lacks one.
fn missing_in(file: &Path, source: &str) -> Vec<String> {
    let parsed = syn::parse_file(source).unwrap_or_else(|e| panic!("parse {}: {e}", file.display()));
    let mut finder = Finder { file: file.to_path_buf(), source, missing: Vec::new() };
    finder.visit_file(&parsed);
    finder.missing
}

#[test]
fn serde_enums_with_struct_variants_name_their_fields() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    for dir in ["src", "serve/src", "tests"] {
        let dir = manifest.join(dir);
        if dir.exists() {
            rust_files(&dir, &mut files);
        }
    }
    assert!(files.len() > 50, "found only {} Rust files; is the walk rooted right?", files.len());
    let missing: Vec<String> = files
        .iter()
        .flat_map(|file| missing_in(file.strip_prefix(manifest).unwrap_or(file), &std::fs::read_to_string(file).unwrap()))
        .collect();
    assert!(
        missing.is_empty(),
        "these serde enums have struct variants but no #[serde(rename_all_fields = …)] decision \
         (rename_all renames only the variant tags; see tests/serde_field_naming.rs):\n  {}",
        missing.join("\n  ")
    );
}

#[test]
fn the_lint_catches_the_197_shape_and_accepts_an_explicit_decision() {
    let file = Path::new("example.rs");
    let bug = r#"
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase", tag = "kind")]
        #[allow(dead_code)] // a trailing comment must not hide it
        enum RemoteEvent { State { connection_id: String } }
    "#;
    assert_eq!(missing_in(file, bug), vec!["example.rs:5 enum RemoteEvent".to_string()]);
    let camel = r#"
        #[derive(serde::Serialize)]
        #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
        enum RemoteEvent { State { connection_id: String } }
    "#;
    assert!(missing_in(file, camel).is_empty());
    let snake = r#"
        #[derive(Deserialize)]
        #[serde(tag = "stage")]
        #[serde(rename_all_fields = "snake_case")] // on disk already
        enum Record { Applying { launch_id: String } }
    "#;
    assert!(missing_in(file, snake).is_empty());
    let unit_and_tuple_only = r#"
        #[derive(Serialize)]
        enum Plain { A, B(String) }
    "#;
    assert!(missing_in(file, unit_and_tuple_only).is_empty());
    let not_serde = r#"
        #[derive(Debug)]
        enum Internal { A { some_field: u8 } }
    "#;
    assert!(missing_in(file, not_serde).is_empty());
}
