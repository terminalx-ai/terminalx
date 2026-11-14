//! What each user setting accepts beyond its JSON type, in one table. The file
//! validator (`file::validate`) checks a settings file against it and
//! [`user_schema`] writes it into the published JSON schema, so an editor's
//! schema cannot say something the app does not enforce (PRO-140).
//!
//! The JSON type of every key comes from the same place for both: the settings
//! template (`file::TEMPLATE`, the defaults of [`super::Settings`]) and its
//! user-defined maps (`file::DYNAMIC_MAPS`). A key here is a dotted path in
//! that template, with `*` for one entry of a user-defined map.
use std::path::Path;

use anyhow::Result;
use serde_json::{Map, Value};

use super::file::DYNAMIC_MAPS;

/// The user file's own `$schema`: the copy kept beside it in `$TERMINALX_HOME`.
pub const USER_SCHEMA_REFERENCE: &str = "./schemas/settings.schema.json";
/// Where the user schema is kept, relative to `$TERMINALX_HOME`.
pub const USER_SCHEMA_PATH: &str = "schemas/settings.schema.json";
/// A repository file's `$schema`: the schema published with the source.
pub const REPOSITORY_SCHEMA_REFERENCE: &str = "https://raw.githubusercontent.com/terminalx-ai/terminalx/main/schemas/repository-settings.schema.json";

/// The schema this build was made with; a test keeps it equal to [`user_schema`].
pub const BUNDLED_USER_SCHEMA: &str = include_str!("../../../../schemas/settings.schema.json");

pub(crate) enum Rule {
    /// A string, one of these.
    OneOf(&'static [&'static str]),
    /// A whole number, one of these.
    Intervals(&'static [u32]),
    /// A whole number from `min` to `max`.
    Whole { min: u32, max: u32 },
    /// A number above 0 and at most `max`, or `"none"` (any case) for No limit.
    Cap { max: f64 },
    /// A string, or null for turned off.
    StringOrNull,
}

pub(crate) struct Constraint {
    pub key: &'static str,
    pub rule: Rule,
    /// What the file's error says when the value breaks the rule. Never the value.
    pub why: &'static str,
}

const fn one_of(key: &'static str, choices: &'static [&'static str]) -> Constraint {
    Constraint { key, rule: Rule::OneOf(choices), why: "unknown option" }
}
const fn intervals(key: &'static str, values: &'static [u32]) -> Constraint {
    Constraint { key, rule: Rule::Intervals(values), why: "choose one of the supported intervals" }
}
const fn whole(key: &'static str, min: u32, max: u32, why: &'static str) -> Constraint {
    Constraint { key, rule: Rule::Whole { min, max }, why }
}
const fn cap(key: &'static str, max: f64, why: &'static str) -> Constraint {
    Constraint { key, rule: Rule::Cap { max }, why }
}

const PIECES: &str = "expected a number of pieces from 1 to 50";
const DIFF_LINES: &str = "expected a number of changed lines from 1 to 100000";
const WORKERS: &str = "expected a number of workers from 1 to 50";
const DOLLARS: &str = "expected dollars above 0, at most 10000, or \"none\" for no limit";
const TRIES: &str = "expected a number of tries from 1 to 6";
const CEILING: &str = "expected one of low, medium, high, xhigh or max";
const PERCENT: &str = "expected a percentage above 0, at most 100, or \"none\" for no limit";

pub(crate) const CONSTRAINTS: &[Constraint] = &[
    one_of("statusBar.percent", &["used", "remaining"]),
    one_of("statusBar.usageMode", &["detailed", "compact"]),
    one_of("preferences.linkBrowser", &["terminalx", "system", "ask"]),
    one_of("preferences.branchSessions", &["tabs", "sidebar"]),
    one_of("preferences.updateChannel", &["stable", "beta"]),
    one_of("preferences.fontScale", &["sm", "md", "lg"]),
    one_of("preferences.transcriptLayout", &["wide", "chat"]),
    one_of("preferences.sidebarLayout", &["simple", "list", "status"]),
    one_of("preferences.organizationDisplay", &["all", "one"]),
    one_of("preferences.theme", &["den", "slate", "moss", "ember"]),
    one_of("preferences.mode", &["system", "light", "dark"]),
    one_of("orchestrator.workerMode", &super::WORKER_MODES),
    one_of("orchestrator.projects.*.workerMode", &super::WORKER_MODES),
    intervals("agents.idleStopMinutes", &super::IDLE_STOP_MINUTES),
    intervals("conversations.archiveIdleDays", &super::ARCHIVE_IDLE_DAYS),
    intervals("mergedCleanup.graceMinutes", &super::GRACE_MINUTES),
    intervals("statusBar.usageRefreshMinutes", &super::USAGE_REFRESH_MINUTES),
    whole("orchestrator.pieceLimit", 1, super::MAX_PIECE_LIMIT, PIECES),
    whole("orchestrator.projects.*.pieceLimit", 1, super::MAX_PIECE_LIMIT, PIECES),
    whole("orchestrator.reviewDiffLines", 1, super::MAX_REVIEW_DIFF_LINES, DIFF_LINES),
    whole("orchestrator.projects.*.reviewDiffLines", 1, super::MAX_REVIEW_DIFF_LINES, DIFF_LINES),
    // PRO-280: a run's limits. The budget and the window level take fractions; the counts do not.
    whole("orchestrator.workersPerRun", 1, super::MAX_WORKERS, WORKERS),
    whole("orchestrator.workersAtOnce", 1, super::MAX_WORKERS, WORKERS),
    whole("orchestrator.stallMinutes", 1, super::MAX_STALL_MINUTES, "expected minutes from 1 to 240"),
    // PRO-362: how many tries a piece gets and the effort escalation stops at.
    whole("orchestrator.triesPerPiece", 1, super::MAX_TRIES_PER_PIECE, TRIES),
    whole("orchestrator.projects.*.triesPerPiece", 1, super::MAX_TRIES_PER_PIECE, TRIES),
    Constraint { key: "orchestrator.effortCeiling", rule: Rule::OneOf(&crate::orchestration::routing::EFFORTS), why: CEILING },
    Constraint { key: "orchestrator.projects.*.effortCeiling", rule: Rule::OneOf(&crate::orchestration::routing::EFFORTS), why: CEILING },
    // PRO-335: a budget or the window level may also be "none", No limit.
    cap("orchestrator.budgetDollars", super::MAX_BUDGET_DOLLARS, DOLLARS),
    cap("orchestrator.projects.*.budgetDollars", super::MAX_BUDGET_DOLLARS, DOLLARS),
    cap("orchestrator.budgetPoints", 100.0, PERCENT),
    cap("orchestrator.projects.*.budgetPoints", 100.0, PERCENT),
    cap("orchestrator.windowCeiling", 100.0, PERCENT),
    cap("orchestrator.projects.*.windowCeiling", 100.0, PERCENT),
    whole("floating.retentionDays", 0, super::MAX_RETENTION_DAYS, "expected days from 0 to 3650"),
    // Turned off is written as null, and null is not "use the default".
    Constraint { key: "floating.shortcut", rule: Rule::StringOrNull, why: "expected a string" },
];

pub(crate) fn constraint(key: &str) -> Option<&'static Constraint> {
    CONSTRAINTS.iter().find(|constraint| constraint.key == key)
}

/// The schema path of `name` inside the object at `pattern`: a user-defined
/// map's entries are all `*`.
pub(crate) fn child(pattern: &str, name: &str) -> String {
    if DYNAMIC_MAPS.contains_key(pattern) { format!("{pattern}.*") }
    else if pattern.is_empty() { name.to_owned() }
    else { format!("{pattern}.{name}") }
}

impl Rule {
    pub(crate) fn accepts(&self, value: &Value) -> bool {
        match self {
            Rule::OneOf(choices) => value.as_str().is_some_and(|text| choices.contains(&text)),
            Rule::Intervals(values) => value.as_u64().is_some_and(|n| values.iter().any(|v| u64::from(*v) == n)),
            Rule::Whole { min, max } => value.as_u64().is_some_and(|n| (u64::from(*min)..=u64::from(*max)).contains(&n)),
            Rule::Cap { max } => super::Cap::from_value(value).is_some_and(|cap| cap.at().is_none_or(|v| v.is_finite() && v > 0.0 && v <= *max)),
            Rule::StringOrNull => value.is_string() || value.is_null(),
        }
    }
}

/// Keep `$TERMINALX_HOME/schemas/settings.schema.json` this build's schema, so
/// the user file's `$schema` describes what this build accepts. It is written
/// only when its bytes differ: an editor watching it is not woken for nothing.
pub fn install_user_schema(home: &Path) -> Result<()> {
    let path = home.join(USER_SCHEMA_PATH);
    if std::fs::read(&path).is_ok_and(|bytes| bytes == BUNDLED_USER_SCHEMA.as_bytes()) { return Ok(()); }
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    crate::store::write_atomic(&path, BUNDLED_USER_SCHEMA.as_bytes())
}

/// The `$schema` the app writes into a file it saves, unless the person wrote one.
pub(crate) fn add_reference(document: &mut Map<String, Value>, reference: &str) {
    if !document.contains_key("$schema") { document.insert("$schema".into(), Value::String(reference.into())); }
}

/// Writes [`CONSTRAINTS`] and the template into the published schema. Only the
/// tests run it: they compare its output with the committed file, which is
/// what the app bundles and installs.
#[cfg(test)]
pub(crate) mod generator {
    use super::*;
    use std::collections::BTreeMap;
    use serde_json::json;
    use super::super::file::TEMPLATE;

    pub(crate) const DESCRIPTIONS: &str = include_str!("../../../../schemas/settings-descriptions.json");

    impl Rule {
        pub(crate) fn schema(&self) -> Value {
            match self {
                Rule::OneOf(choices) => json!({"type": "string", "enum": choices}),
                Rule::Intervals(values) => json!({"type": "integer", "enum": values}),
                Rule::Whole { min, max } => json!({"type": "integer", "minimum": min, "maximum": max}),
                Rule::Cap { max } => json!({"anyOf": [
                    {"type": "number", "exclusiveMinimum": 0, "maximum": max},
                    {"type": "string", "pattern": "^\\s*[Nn][Oo][Nn][Ee]\\s*$", "description": "No limit."},
                ]}),
                Rule::StringOrNull => json!({"type": ["string", "null"]}),
            }
        }
    }

    /// The JSON type a template value stands for, as `file::validate` reads it.
    fn type_schema(expected: &Value) -> Value {
        match expected {
            Value::Array(_) => json!({"type": "array", "items": {"type": "string"}}),
            Value::Bool(_) => json!({"type": "boolean"}),
            Value::String(_) => json!({"type": "string"}),
            Value::Number(_) => json!({"type": "integer", "minimum": 0, "maximum": u32::MAX}),
            // An optional string the defaults leave unset (a credential, a device, a name).
            Value::Null => json!({"type": ["string", "null"]}),
            Value::Object(_) => json!({"type": "object"}),
        }
    }

    /// `orchestration::routing` reads its own rows (tier and effort per kind and
    /// agent); the defaults leave the table empty, so it is not in the template.
    fn routing() -> Value {
        json!({
            "type": "object",
            "description": "Changed rows of the orchestration routing table: which tier and effort a kind of piece starts on, per agent.",
            "additionalProperties": {"type": "object", "additionalProperties": {"type": "object"}},
        })
    }

    fn node(expected: &Value, pattern: &str, descriptions: &BTreeMap<String, String>) -> Value {
        let mut schema = if let Some(constraint) = constraint(pattern) {
            constraint.rule.schema()
        } else if let Some(entry) = DYNAMIC_MAPS.get(pattern) {
            json!({"type": "object", "additionalProperties": node(entry, &format!("{pattern}.*"), descriptions)})
        } else if let Value::Object(properties) = expected {
            let mut children: Map<String, Value> = properties.iter()
                .map(|(name, kind)| (name.clone(), node(kind, &child(pattern, name), descriptions)))
                .collect();
            if pattern == "orchestrator" || pattern == "orchestrator.projects.*" {
                let mut table = routing();
                if let Some(description) = descriptions.get(&child(pattern, "routing")) { table["description"] = Value::String(description.clone()); }
                children.insert("routing".into(), table);
            }
            if pattern.is_empty() {
                children.insert("$schema".into(), json!({"type": "string", "description": "The JSON schema editors check this file against."}));
            }
            json!({"type": "object", "properties": children, "additionalProperties": false})
        } else {
            type_schema(expected)
        };
        if let Some(description) = descriptions.get(pattern) {
            schema["description"] = Value::String(description.clone());
        }
        schema
    }

    /// The schema of `$TERMINALX_HOME/settings.json`, from the settings template,
    /// [`CONSTRAINTS`] and `schemas/settings-descriptions.json` (each key's
    /// Settings row). Keys this build does not know are allowed in the file and
    /// kept, but an editor flags them: this build ignores them.
    pub fn user_schema() -> Value {
        let descriptions: BTreeMap<String, String> = serde_json::from_str(DESCRIPTIONS).expect("bundled settings descriptions");
        let mut schema = node(&TEMPLATE, "", &descriptions);
        let object = schema.as_object_mut().expect("the template is an object");
        let mut head = Map::new();
        head.insert("$schema".into(), json!("https://json-schema.org/draft/2020-12/schema"));
        head.insert("title".into(), json!("TerminalX user settings"));
        head.insert("description".into(), json!("$TERMINALX_HOME/settings.json (default ~/.raccoon/settings.json). A missing key inherits its default; repository and managed settings are layered above this file."));
        head.append(object);
        Value::Object(head)
    }

    /// The text a schema file holds: pretty JSON and a final newline.
    pub fn text(schema: &Value) -> String {
        format!("{}\n", serde_json::to_string_pretty(schema).expect("schema JSON"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::generator::{text, user_schema, DESCRIPTIONS};
    use super::super::file::TEMPLATE;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn schema_at<'a>(schema: &'a Value, path: &[&str]) -> &'a Value {
        path.iter().fold(schema, |node, name| if *name == "*" { &node["additionalProperties"] } else { &node["properties"][name] })
    }

    /// The committed schemas are the generated ones. After changing the
    /// settings template, a constraint, the layered registry or a description,
    /// regenerate them: `TERMINALX_WRITE_SCHEMAS=1 cargo t --lib store::settings::schema`.
    #[test]
    fn committed_schemas_are_the_generated_ones() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        for (file, schema) in [
            ("schemas/settings.schema.json", user_schema()),
            ("schemas/repository-settings.schema.json", crate::store::configuration::repository_schema()),
        ] {
            let generated = text(&schema);
            let path = root.join(file);
            if std::env::var_os("TERMINALX_WRITE_SCHEMAS").is_some() { std::fs::write(&path, &generated).unwrap(); }
            let committed = std::fs::read_to_string(&path).unwrap_or_default();
            assert!(committed == generated, "{file} is stale: run `TERMINALX_WRITE_SCHEMAS=1 cargo t --lib store::settings::schema` in src-tauri and commit the result");
        }
        if std::env::var_os("TERMINALX_WRITE_SCHEMAS").is_none() {
            assert_eq!(BUNDLED_USER_SCHEMA, text(&user_schema()), "rebuild after regenerating: the bundled copy is compiled in");
        }
    }

    #[test]
    fn every_constraint_names_a_key_of_the_template_and_reaches_the_schema() {
        let schema = user_schema();
        for constraint in CONSTRAINTS {
            let path: Vec<&str> = constraint.key.split('.').collect();
            let node = schema_at(&schema, &path);
            assert_eq!(node, &{
                let mut expected = constraint.rule.schema();
                if let Some(description) = node.get("description") { expected["description"] = description.clone(); }
                expected
            }, "{}", constraint.key);
        }
        assert_eq!(schema_at(&schema, &["preferences", "theme"])["enum"], json!(["den", "slate", "moss", "ember"]));
        // Each key's description is its Settings row's, from settings-descriptions.json.
        let descriptions: BTreeMap<String, String> = serde_json::from_str(DESCRIPTIONS).unwrap();
        for (key, description) in &descriptions {
            let path: Vec<&str> = match key.strip_prefix("preferences.shortcuts.") {
                Some(_) => continue, // one row per shortcut action, all entries of one map
                None => key.split('.').collect(),
            };
            assert_eq!(schema_at(&schema, &path)["description"], description.as_str(), "{key}");
        }
    }

    #[test]
    fn the_validator_refuses_what_the_schema_forbids() {
        let schema = user_schema();
        // An enum: the schema's choices are the validator's.
        let choices = schema_at(&schema, &["preferences", "mode"])["enum"].as_array().unwrap().clone();
        for choice in &choices { super::super::file::check(&json!({"preferences": {"mode": choice}})).unwrap(); }
        assert!(super::super::file::check(&json!({"preferences": {"mode": "sepia"}})).unwrap_err().to_string().contains("preferences.mode"));
        // A range: both bounds are in, one past each is out.
        let limit = schema_at(&schema, &["orchestrator", "pieceLimit"]);
        let (min, max) = (limit["minimum"].as_u64().unwrap(), limit["maximum"].as_u64().unwrap());
        for ok in [min, max] { super::super::file::check(&json!({"orchestrator": {"pieceLimit": ok}})).unwrap(); }
        for bad in [min - 1, max + 1] {
            assert!(super::super::file::check(&json!({"orchestrator": {"pieceLimit": bad}})).unwrap_err().to_string().contains("orchestrator.pieceLimit"));
        }
        let project = schema_at(&schema, &["orchestrator", "projects", "*", "pieceLimit"]);
        assert_eq!((&project["minimum"], &project["maximum"]), (&limit["minimum"], &limit["maximum"]), "a project's piece limit has the app-wide bounds");
        assert!(super::super::file::check(&json!({"orchestrator": {"projects": {"/repo": {"pieceLimit": 0}}}})).is_err());
        // An interval set.
        let minutes = schema_at(&schema, &["agents", "idleStopMinutes"])["enum"].as_array().unwrap().clone();
        for ok in &minutes { super::super::file::check(&json!({"agents": {"idleStopMinutes": ok}})).unwrap(); }
        assert!(super::super::file::check(&json!({"agents": {"idleStopMinutes": 7}})).is_err());
        // A type: boolean, a list of strings, and a cap that may be "none".
        assert_eq!(schema_at(&schema, &["notifications"])["type"], "boolean");
        assert!(super::super::file::check(&json!({"notifications": "yes"})).is_err());
        assert_eq!(schema_at(&schema, &["extraBinDirs"]), &json!({"type": "array", "items": {"type": "string"}}));
        assert!(super::super::file::check(&json!({"extraBinDirs": [1]})).is_err());
        super::super::file::check(&json!({"orchestrator": {"budgetDollars": "none", "windowCeiling": 100}})).unwrap();
        assert!(super::super::file::check(&json!({"orchestrator": {"windowCeiling": 0}})).is_err());
        assert_eq!(schema_at(&schema, &["floating", "shortcut"])["type"], json!(["string", "null"]));
        // The defaults are valid, and every key of them is described by the schema.
        super::super::file::check(&TEMPLATE).unwrap();
        for name in TEMPLATE.as_object().unwrap().keys() { assert!(schema["properties"].get(name).is_some(), "{name}"); }
        assert!(schema["properties"]["orchestrator"]["properties"].get("routing").is_some());
    }

    #[test]
    fn the_user_schema_is_kept_current_and_written_only_when_it_differs() {
        let home = tempfile::tempdir().unwrap();
        install_user_schema(home.path()).unwrap();
        let path = home.path().join(USER_SCHEMA_PATH);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), BUNDLED_USER_SCHEMA);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        install_user_schema(home.path()).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified, "same bytes: not rewritten");
        std::fs::write(&path, "{}").unwrap();
        install_user_schema(home.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), BUNDLED_USER_SCHEMA);
    }
}
