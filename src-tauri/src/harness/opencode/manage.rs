//! OpenCode's providers and models, managed from Settings → Agents (PRO-157).
//!
//! Nothing here is TerminalX's own store. A provider's key goes where
//! `opencode auth login` puts it, OpenCode's `auth.json` in its data folder,
//! so the CLI on its own and every TerminalX tab read the same login. Which
//! models the picker offers is OpenCode's own `whitelist` for the provider in
//! its global config file: OpenCode then offers only those, and the composer
//! lists exactly them ([`picker_models`]). A connected provider starts with
//! an empty list, so nothing appears until a model is added (screen 10.16).
//!
//! The provider catalogue is models.dev's, which OpenCode keeps a copy of in
//! its cache folder; it is fetched only when that copy is missing. Ollama is
//! not in it: OpenCode documents it as an OpenAI-compatible provider of the
//! config file's own, which is what connecting it writes.
//!
//! The config file may be JSONC. It is read with its comments, and refused
//! for writing while it has any, since rewriting it would drop them.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};

/// Where OpenCode keeps what this module reads and writes. OpenCode uses the
/// XDG folders on every platform, `~/.config` and the rest when unset.
#[derive(Debug, Clone)]
pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl Paths {
    pub fn user() -> Option<Self> {
        let home = dirs::home_dir()?;
        let xdg = |name: &str, fallback: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(fallback));
        Some(Self {
            config_dir: xdg("XDG_CONFIG_HOME", ".config").join("opencode"),
            data_dir: xdg("XDG_DATA_HOME", ".local/share").join("opencode"),
            cache_dir: xdg("XDG_CACHE_HOME", ".cache").join("opencode"),
        })
    }

    /// The global config file. OpenCode reads `opencode.json` and then
    /// `opencode.jsonc` over it, so the `.jsonc` one wins when both exist;
    /// a new file is `opencode.json`.
    pub fn config_file(&self) -> PathBuf {
        let jsonc = self.config_dir.join("opencode.jsonc");
        if jsonc.is_file() { jsonc } else { self.config_dir.join("opencode.json") }
    }

    pub fn auth_file(&self) -> PathBuf {
        self.data_dir.join("auth.json")
    }

    pub fn log_dir(&self) -> PathBuf {
        self.data_dir.join("log")
    }

    fn catalog_file(&self) -> PathBuf {
        self.cache_dir.join("models.json")
    }
}

/// The local Ollama server, as OpenCode's documentation configures it.
pub const OLLAMA: &str = "ollama";
const OLLAMA_URL: &str = "http://localhost:11434/v1";


/// One provider of the catalogue.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProvider {
    pub id: String,
    pub name: String,
    /// The variables OpenCode reads its key from, first is the usual one.
    pub env: Vec<String>,
    /// Where the provider's API answers, when the catalogue says.
    pub api: Option<String>,
    pub doc: Option<String>,
    pub model_count: usize,
    /// Runs on this Mac and needs no key.
    pub local: bool,
    /// The address set for it in the config file, kept while it is disconnected.
    pub base_url: Option<String>,
}

/// A model the catalogue lists for a provider.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
}

/// A provider OpenCode can use now.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub id: String,
    pub name: String,
    /// "api": a key in auth.json; "oauth": a sign-in OpenCode made itself;
    /// "config": a key or server in the config file.
    pub auth: String,
    /// The key's first and last characters, never more.
    pub masked_key: Option<String>,
    pub base_url: Option<String>,
    /// What the picker offers from it, in the config file's order.
    pub models: Vec<String>,
    /// No list in the config file: OpenCode offers every model it knows,
    /// and the picker none until one is added.
    pub unlisted: bool,
    pub catalog_models: usize,
}

/// A model in the composer's picker.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PickerModel {
    /// `provider/model`, as a tab stores it.
    pub id: String,
    pub provider: String,
    pub provider_name: String,
    pub model: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub config_path: String,
    pub config_exists: bool,
    /// Why TerminalX will not write the config file now.
    pub config_problem: Option<String>,
    pub auth_path: String,
    pub log_dir: String,
    pub connected: Vec<Connected>,
    pub models: Vec<PickerModel>,
    pub catalog: Vec<CatalogProvider>,
    /// Why the catalogue is missing, when it is.
    pub catalog_problem: Option<String>,
    /// Why TerminalX will not write OpenCode's key file now.
    pub auth_problem: Option<String>,
}

/// What checking a key with its provider said.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "result")]
pub enum KeyCheck {
    Accepted,
    /// The provider could not be asked, or has no way to ask; saved anyway.
    NotChecked { reason: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub overview: Overview,
    pub check: KeyCheck,
}

// ------------------------------------------------------------------ JSONC

/// `text` without its comments and trailing commas, and whether it had
/// comments. Strings are copied as they are, escapes and all.
fn strip_jsonc(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut commented = false;
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                while let Some(c) = chars.next() {
                    out.push(c);
                    if c == '\\' { if let Some(next) = chars.next() { out.push(next); } } else if c == '"' { break; }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                commented = true;
                for c in chars.by_ref() { if c == '\n' { out.push('\n'); break; } }
            }
            '/' if chars.peek() == Some(&'*') => {
                commented = true;
                chars.next();
                let mut last = '\0';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' { break; }
                    if c == '\n' { out.push('\n'); }
                    last = c;
                }
            }
            _ => out.push(c),
        }
    }
    // A comma whose next significant character closes the object or list.
    let bytes: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(out.len());
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            cleaned.push(c);
            if c == '\\' { if let Some(next) = bytes.get(i + 1) { cleaned.push(*next); i += 1; } } else if c == '"' { in_string = false; }
        } else if c == '"' {
            in_string = true;
            cleaned.push(c);
        } else if c == ',' && bytes[i + 1..].iter().find(|c| !c.is_whitespace()).is_some_and(|next| *next == '}' || *next == ']') {
            // dropped
        } else {
            cleaned.push(c);
        }
        i += 1;
    }
    (cleaned, commented)
}

/// The config file: its contents, and whether it may be written.
struct Config {
    path: PathBuf,
    exists: bool,
    value: Map<String, Value>,
    problem: Option<String>,
    /// `value` is what the file says (or it is missing). False when it couldn't be read
    /// or parsed: then `value` is empty, not the truth, and nothing may be decided from it.
    known: bool,
}

fn shown(path: &Path) -> String {
    match dirs::home_dir().and_then(|home| path.strip_prefix(&home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

fn read_config(paths: &Paths) -> Config {
    let path = paths.config_file();
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Config { path, exists: false, value: Map::new(), problem: None, known: true },
        // Not "missing": its gateway would be ignored and the file replaced.
        Err(error) => { let problem = Some(format!("Couldn’t read {}: {error}. TerminalX won’t change it until it can.", shown(&path))); return Config { path, exists: true, value: Map::new(), problem, known: false }; }
    };
    let (plain, commented) = strip_jsonc(&text);
    match serde_json::from_str::<Value>(if plain.trim().is_empty() { "{}" } else { &plain }) {
        Ok(Value::Object(value)) => {
            let problem = commented.then(|| format!("{} has comments, which TerminalX would lose by rewriting it. Make this change in the file, or remove its comments first.", shown(&path)));
            Config { path, exists: true, value, problem, known: true }
        }
        Ok(_) => Config { path: path.clone(), exists: true, value: Map::new(), problem: Some(format!("{} is not a JSON object. Fix it in an editor first.", shown(&path))), known: false },
        Err(error) => Config { path: path.clone(), exists: true, value: Map::new(), problem: Some(format!("{} can’t be read: {error}. Fix it in an editor first.", shown(&path))), known: false },
    }
}

/// Replace `path` with `value`, through a file beside it, owner-only when `private`.
fn write_json(path: &Path, value: &Value, private: bool) -> Result<(), String> {
    write_json_unless(path, value, private, || false).map(|_| ())
}

/// [`write_json`], left undone (`Ok(false)`) when `abandon`, asked right before
/// the new file replaces `path`, says so.
fn write_json_unless(path: &Path, value: &Value, private: bool, abandon: impl FnOnce() -> bool) -> Result<bool, String> {
    let parent = path.parent().ok_or("no folder to write in")?;
    std::fs::create_dir_all(parent).map_err(|error| format!("Couldn’t create {}: {error}", shown(parent)))?;
    let text = format!("{}\n", serde_json::to_string_pretty(value).map_err(|error| error.to_string())?);
    // A key file someone left readable by others is narrowed first, as `opencode auth login`
    // keeps it: write_atomic carries an existing file's mode over to the new one.
    if private { narrow(path)?; }
    // Created owner-only and fsynced before the rename, so keys are never readable mid-write.
    crate::store::write_atomic_unless(path, text.as_bytes(), abandon).map_err(|error| format!("Couldn’t write {}: {error:#}", shown(path)))
}

/// Make an existing key file that others may read owner-only.
fn narrow(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|error| format!("Couldn’t make {} private: {error}", shown(path)))?;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Change the config file with `edit`, unless it may not be written.
fn edit_config(paths: &Paths, edit: impl FnOnce(&mut Map<String, Value>) -> Result<(), String>) -> Result<(), String> {
    let mut config = read_config(paths);
    if let Some(problem) = config.problem { return Err(problem); }
    if !config.exists { config.value.insert("$schema".into(), json!("https://opencode.ai/config.json")); }
    edit(&mut config.value)?;
    write_json(&config.path, &Value::Object(config.value), false)
}

/// `provider.<id>` in the config, made when missing.
fn provider_entry<'a>(config: &'a mut Map<String, Value>, id: &str) -> Result<&'a mut Map<String, Value>, String> {
    let providers = config.entry("provider").or_insert_with(|| json!({}));
    let providers = providers.as_object_mut().ok_or("The config file’s \"provider\" is not an object. Fix it in an editor first.")?;
    providers.entry(id.to_owned()).or_insert_with(|| json!({})).as_object_mut().ok_or_else(|| format!("The config file’s provider \"{id}\" is not an object. Fix it in an editor first."))
}

/// OpenCode's key file. Missing is no keys yet. One that is there but can't
/// be read as a JSON object is an error, since writing back only what could
/// be read would delete every other provider's key or sign-in. OpenCode
/// rewrites the file in place (truncate, then write), so an empty or cut-off
/// read is tried again briefly before it counts as broken.
fn read_auth(paths: &Paths) -> Result<Map<String, Value>, String> {
    read_auth_bytes(paths).map(|(_, map)| map)
}

/// The key file's text as read (None when missing) and the keys in it.
fn auth_text(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Couldn’t read {}: {error}. TerminalX won’t change it until it can.", shown(file))),
    }
}

/// [`read_auth`], with the text the keys came from.
fn read_auth_bytes(paths: &Paths) -> Result<(Option<String>, Map<String, Value>), String> {
    let file = paths.auth_file();
    let mut tries = 0;
    loop {
        let Some(text) = auth_text(&file)? else { return Ok((None, Map::new())) };
        let problem = match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => return Ok((Some(text), map)),
            Ok(_) => "isn’t a JSON object",
            Err(_) if text.trim().is_empty() => "is empty",
            Err(_) => "isn’t valid JSON",
        };
        tries += 1;
        if tries == AUTH_READS {
            return Err(format!("{} {problem}, so TerminalX won’t change it: saving would drop OpenCode’s other sign-ins. Run `opencode auth list` or fix the file, then try again.", shown(&file)));
        }
        std::thread::sleep(AUTH_RETRY);
    }
}

const AUTH_READS: u32 = 3;
const AUTH_RETRY: Duration = Duration::from_millis(100);

/// Change the key file with `edit`, keeping every other entry as OpenCode last
/// wrote it. OpenCode rewrites the file without a lock (say to refresh a
/// sign-in), so once the new file is written and synced beside it, the key
/// file is read again right before the rename swaps the new one in; if it
/// changed since `edit` saw it, the new file is dropped and the edit made again
/// on the new text, rather than putting back what OpenCode just replaced.
///
/// This is an optimistic check, not a compare-and-swap: OpenCode takes no lock
/// TerminalX could share, and a lock of TerminalX's own can't stop it. A write
/// of OpenCode's landing in the moment between that last read and the rename
/// is still replaced. The window is a read and a rename long, not the edit,
/// serialization and sync before them.
fn update_auth(paths: &Paths, mut edit: impl FnMut(&mut Map<String, Value>)) -> Result<(), String> {
    let file = paths.auth_file();
    for _ in 0..AUTH_UPDATES {
        let (seen, mut auth) = read_auth_bytes(paths)?;
        let read = auth.clone();
        edit(&mut auth);
        // Nothing to change (say the entry went, or the whole file, since the caller looked):
        // no write, so a deleted file isn't made again as `{}` and the file is left as it is.
        // One left readable by others is still made owner-only, as a write would have.
        if auth == read { return if seen.is_some() { narrow(&file) } else { Ok(()) }; }
        #[cfg(test)]
        BEFORE_AUTH_WRITE.with(|hook| if let Some(hook) = hook.borrow_mut().as_mut() { hook() });
        // Asked once the new file is ready, right before it replaces this one.
        let mut now = Ok(None);
        let written = write_json_unless(&file, &Value::Object(auth), true, || {
            #[cfg(test)]
            BEFORE_AUTH_REPLACE.with(|hook| if let Some(hook) = hook.borrow_mut().as_mut() { hook() });
            now = auth_text(&file);
            !matches!(&now, Ok(text) if *text == seen)
        })?;
        if written { return Ok(()); }
        now?;
    }
    Err(format!("{} kept changing while TerminalX was saving, so it was left as OpenCode wrote it. Try again in a moment.", shown(&file)))
}

const AUTH_UPDATES: u32 = 5;

#[cfg(test)]
thread_local! {
    /// Run by [`update_auth`] between its edit and its write: where another writer's change lands.
    static BEFORE_AUTH_WRITE: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
    /// Run by [`update_auth`] once the new key file is written beside the old one, before
    /// the last look at the old one: where a refresh after the edit's own read lands.
    static BEFORE_AUTH_REPLACE: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 12 { return "•".repeat(8); }
    // The provider's prefix ("sk-or-", "gsk_"), which says nothing secret, else four characters.
    let head_len = chars.iter().take(7).rposition(|c| *c == '-' || *c == '_').map_or(4, |at| at + 1);
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}••••••••{tail}")
}

// ------------------------------------------------------------------ catalogue

const CATALOG_URL: &str = "https://models.dev/api.json";
const CATALOG_TIMEOUT: Duration = Duration::from_secs(10);

fn catalog_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| crate::data_privacy::http_agent().timeout(CATALOG_TIMEOUT).build())
}

/// models.dev's providers, from OpenCode's copy or, without one, the site.
fn catalog_value(paths: &Paths, fetch: bool) -> Result<Map<String, Value>, String> {
    static FETCHED: std::sync::Mutex<Option<Map<String, Value>>> = std::sync::Mutex::new(None);
    catalog_from(paths, fetch, &FETCHED, || {
        let value = catalog_agent().get(CATALOG_URL).call().map_err(|error| format!("Couldn’t download the provider list from models.dev: {error}"))?
            .into_json::<Value>().map_err(|error| format!("models.dev sent a provider list TerminalX can’t read: {error}"))?;
        value.as_object().cloned().ok_or_else(|| "models.dev sent a provider list TerminalX can’t read.".to_owned())
    })
}

/// [`catalog_value`] with its in-process copy and its download given. A list
/// already downloaded this run serves `fetch: false` too, so the overview an
/// action returns sees the same providers as the one before it.
fn catalog_from(paths: &Paths, fetch: bool, fetched: &std::sync::Mutex<Option<Map<String, Value>>>, download: impl FnOnce() -> Result<Map<String, Value>, String>) -> Result<Map<String, Value>, String> {
    if let Some(cached) = std::fs::read_to_string(paths.catalog_file()).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).and_then(|value| value.as_object().cloned()) {
        return Ok(cached);
    }
    if let Some(copy) = fetched.lock().unwrap_or_else(|poison| poison.into_inner()).clone() { return Ok(copy); }
    if !fetch { return Err("OpenCode has not downloaded its provider list yet.".into()); }
    let map = download()?;
    *fetched.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(map.clone());
    Ok(map)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn catalog_provider(id: &str, value: &Value) -> CatalogProvider {
    CatalogProvider {
        id: id.to_owned(),
        name: text(value, "name").unwrap_or_else(|| id.to_owned()),
        env: value.get("env").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default(),
        api: text(value, "api"),
        doc: text(value, "doc"),
        model_count: value.get("models").and_then(Value::as_object).map_or(0, Map::len),
        base_url: None,
        local: false,
    }
}

fn ollama() -> CatalogProvider {
    CatalogProvider { id: OLLAMA.into(), name: "Ollama".into(), env: Vec::new(), api: Some(OLLAMA_URL.into()), doc: Some("https://opencode.ai/docs/providers/#ollama".into()), model_count: 0, local: true, base_url: None }
}

fn catalog_list(catalog: &Map<String, Value>) -> Vec<CatalogProvider> {
    let mut list: Vec<CatalogProvider> = catalog.iter().map(|(id, value)| catalog_provider(id, value)).collect();
    if !catalog.contains_key(OLLAMA) { list.push(ollama()); }
    list.sort_by_key(|provider| provider.name.to_lowercase());
    list
}

/// The catalogue's models for one provider, by name.
pub fn catalog_models(paths: &Paths, provider: &str) -> Result<Vec<CatalogModel>, String> {
    let catalog = catalog_value(paths, true)?;
    let mut models: Vec<CatalogModel> = catalog.get(provider).and_then(|value| value.get("models")).and_then(Value::as_object)
        .map(|models| models.iter().map(|(id, model)| CatalogModel { id: id.clone(), name: text(model, "name").unwrap_or_else(|| id.clone()) }).collect())
        .unwrap_or_default();
    models.sort_by_key(|model| model.name.to_lowercase());
    Ok(models)
}

// ------------------------------------------------------------------ reading

fn model_list(entry: Option<&Value>) -> Option<Vec<String>> {
    entry?.get("whitelist")?.as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())
}

/// A provider that is a server of its own, set up in the config file (npm plus
/// an address) and unknown to the catalogue: Ollama, or one made by hand. It
/// is listed without a key, and Disconnect removes it. A catalogue provider's
/// address is a gateway instead, and stays.
///
/// Without the catalogue (`catalog` empty) the providers models.dev listed
/// when TerminalX was built stand in for it, as OpenCode's own snapshot does
/// for OpenCode: a gateway whose keys are gone doesn't look connected, and a
/// hand-made server is listed with or without a name.
fn own_server(id: &str, entry: &Value, catalog: &Map<String, Value>) -> bool {
    let server = entry.get("npm").is_some() && entry.pointer("/options/baseURL").is_some();
    server && (id == OLLAMA || if catalog.is_empty() { !known_provider(id) } else { !catalog.contains_key(id) })
}

/// The provider ids in models.dev's list, one per line, taken from OpenCode's
/// `models.json` cache (2026-11-07). Refresh it with
/// `python3 -c "import json,sys; print('\n'.join(sorted(json.load(open(sys.argv[1])))))" ~/.cache/opencode/models.json > provider_ids.txt`.
const KNOWN_PROVIDERS: &str = include_str!("provider_ids.txt");

fn known_provider(id: &str) -> bool {
    KNOWN_PROVIDERS.lines().any(|known| known == id)
}

fn connected(config: &Map<String, Value>, auth: &Map<String, Value>, catalog: &Map<String, Value>) -> Vec<Connected> {
    let providers = config.get("provider").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut ids: Vec<String> = auth.keys().cloned().collect();
    for (id, entry) in &providers {
        let has_key = entry.pointer("/options/apiKey").and_then(Value::as_str).is_some_and(|key| !key.is_empty());
        if (has_key || own_server(id, entry, catalog)) && !ids.contains(id) { ids.push(id.clone()); }
    }
    let mut list: Vec<Connected> = ids.into_iter().map(|id| {
        let entry = providers.get(&id);
        let stored = auth.get(&id);
        let kind = stored.and_then(|stored| text(stored, "type"));
        let key = stored.filter(|_| kind.as_deref() == Some("api")).and_then(|stored| text(stored, "key"))
            .or_else(|| entry.and_then(|entry| entry.pointer("/options/apiKey")).and_then(Value::as_str).map(str::to_owned));
        let name = catalog.get(&id).and_then(|value| text(value, "name")).or_else(|| entry.and_then(|entry| text(entry, "name"))).unwrap_or_else(|| if id == OLLAMA { "Ollama".into() } else { id.clone() });
        let models = model_list(entry);
        Connected {
            auth: match kind.as_deref() { Some("oauth") => "oauth".into(), Some("wellknown") => "wellknown".into(), Some(_) => "api".into(), None => "config".into() },
            masked_key: key.as_deref().filter(|key| !key.starts_with("{env:")).map(mask),
            base_url: entry.and_then(|entry| entry.pointer("/options/baseURL")).and_then(Value::as_str).map(str::to_owned),
            unlisted: models.is_none(),
            models: models.unwrap_or_default(),
            catalog_models: catalog.get(&id).and_then(|value| value.get("models")).and_then(Value::as_object).map_or(0, Map::len),
            name,
            id,
        }
    }).collect();
    list.sort_by_key(|provider| provider.name.to_lowercase());
    list
}

fn picker_from(connected: &[Connected], catalog: &Map<String, Value>, config: &Map<String, Value>) -> Vec<PickerModel> {
    connected.iter().flat_map(|provider| provider.models.iter().map(move |model| {
        let name = catalog.get(&provider.id).and_then(|value| value.pointer(&format!("/models/{}", model.replace('~', "~0").replace('/', "~1")))).and_then(|value| text(value, "name"))
            .or_else(|| config.get("provider").and_then(|value| value.get(&provider.id)).and_then(|value| value.get("models")).and_then(|value| value.get(model)).and_then(|value| text(value, "name")))
            .unwrap_or_else(|| model.clone());
        PickerModel { id: format!("{}/{model}", provider.id), provider: provider.id.clone(), provider_name: provider.name.clone(), model: model.clone(), name }
    })).collect()
}

pub fn overview_in(paths: &Paths, fetch: bool) -> Overview {
    let config = read_config(paths);
    let (auth, auth_problem) = match read_auth(paths) { Ok(auth) => (auth, None), Err(problem) => (Map::new(), Some(problem)) };
    let (catalog, catalog_problem) = match catalog_value(paths, fetch) { Ok(catalog) => (catalog, None), Err(problem) => (Map::new(), Some(problem)) };
    let connected = connected(&config.value, &auth, &catalog);
    let models = picker_from(&connected, &catalog, &config.value);
    Overview {
        config_path: shown(&config.path),
        config_exists: config.exists,
        config_problem: config.problem,
        auth_path: shown(&paths.auth_file()),
        log_dir: shown(&paths.log_dir()),
        connected,
        models,
        catalog: catalog_list(&catalog).into_iter().map(|mut provider| {
            provider.base_url = config.value.get("provider").and_then(|providers| providers.get(&provider.id)).and_then(|entry| entry.pointer("/options/baseURL")).and_then(Value::as_str).map(str::to_owned);
            provider
        }).collect(),
        catalog_problem,
        auth_problem,
    }
}

/// The models the composer offers for OpenCode: those added in Settings, in
/// order, provider by provider. Read from files alone, never the network.
pub fn picker_models() -> Vec<PickerModel> {
    Paths::user().map(|paths| overview_in(&paths, false).models).unwrap_or_default()
}

// ------------------------------------------------------------------ checking a key

/// Where a provider's model list answers and how a key is shown to it, for
/// the SDKs whose default address the catalogue leaves out.
fn probe_for(provider: &str, npm: Option<&str>, api: Option<&str>, base: Option<&str>) -> Option<(String, &'static str)> {
    if provider == "openrouter" { return Some((format!("{}/key", base.unwrap_or("https://openrouter.ai/api/v1").trim_end_matches('/')), "bearer")); }
    let (default, style) = match npm {
        Some("@ai-sdk/anthropic") => ("https://api.anthropic.com/v1", "anthropic"),
        Some("@ai-sdk/google") => ("https://generativelanguage.googleapis.com/v1beta", "google"),
        Some("@ai-sdk/openai") => ("https://api.openai.com/v1", "bearer"),
        Some("@ai-sdk/groq") => ("https://api.groq.com/openai/v1", "bearer"),
        Some("@ai-sdk/mistral") => ("https://api.mistral.ai/v1", "bearer"),
        Some("@ai-sdk/xai") => ("https://api.x.ai/v1", "bearer"),
        Some("@ai-sdk/togetherai") => ("https://api.together.xyz/v1", "bearer"),
        Some("@ai-sdk/cerebras") => ("https://api.cerebras.ai/v1", "bearer"),
        Some("@ai-sdk/deepinfra") => ("https://api.deepinfra.com/v1/openai", "bearer"),
        Some("@ai-sdk/openai-compatible") => ("", "bearer"),
        _ => return None,
    };
    let root = base.or(api).unwrap_or(default).trim_end_matches('/');
    (!root.is_empty()).then(|| (format!("{root}/models"), style))
}

const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

fn check_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    // Never follow HTTP redirects while carrying API key headers (x-api-key,
    // x-goog-api-key, Authorization), which ureq forwards across 3xx redirects.
    AGENT.get_or_init(|| crate::data_privacy::http_agent().timeout(CHECK_TIMEOUT).redirects(0).build())
}

/// Ask the provider whether it takes `key`. A refusal is an error; a
/// provider that cannot be asked is `NotChecked`.
fn check_key(provider: &CatalogProvider, npm: Option<&str>, key: &str, base: Option<&str>) -> Result<KeyCheck, String> {
    let Some((url, style)) = probe_for(&provider.id, npm, provider.api.as_deref(), base) else {
        return Ok(KeyCheck::NotChecked { reason: format!("TerminalX has no way to check a {} key; OpenCode will say at the first message if it is refused.", provider.name) });
    };
    valid_url(&url)?;
    let request = check_agent().get(&url);
    let request = match style {
        "anthropic" if !key.is_empty() => request.set("x-api-key", key).set("anthropic-version", "2023-06-01"),
        "google" if !key.is_empty() => request.set("x-goog-api-key", key),
        _ if !key.is_empty() => request.set("Authorization", &format!("Bearer {key}")),
        _ => request,
    };
    match request.call() {
        Ok(response) if (300..400).contains(&response.status()) => Err(format!(
            "{} returned an HTTP {} redirect; refusing to follow redirects while checking an API key.",
            provider.name,
            response.status()
        )),
        Ok(_) => Ok(KeyCheck::Accepted),
        Err(ureq::Error::Status(401 | 403, _)) => Err(if key.is_empty() { format!("{} refused the connection without a key.", provider.name) } else { format!("{} didn’t accept this key. Check that it was copied whole and is still active.", provider.name) }),
        Err(ureq::Error::Status(code, _)) => Ok(KeyCheck::NotChecked { reason: format!("{} answered {code}, so the key could not be checked.", provider.name) }),
        Err(error) if provider.local => Err(format!("{} isn’t answering at {}: {error}. Start it, then connect again.", provider.name, base.or(provider.api.as_deref()).unwrap_or(OLLAMA_URL))),
        Err(error) => Ok(KeyCheck::NotChecked { reason: format!("{} couldn’t be reached to check the key: {error}", provider.name) }),
    }
}

// ------------------------------------------------------------------ changing

fn find_provider(paths: &Paths, id: &str) -> Result<(CatalogProvider, Option<String>), String> {
    if id == OLLAMA { return Ok((ollama(), Some("@ai-sdk/openai-compatible".into()))); }
    let catalog = catalog_value(paths, true)?;
    let value = catalog.get(id).ok_or_else(|| format!("OpenCode doesn’t know a provider called {}.", id.chars().take(60).collect::<String>()))?;
    Ok((catalog_provider(id, value), text(value, "npm")))
}

fn is_loopback_host(host: Option<url::Host<&str>>) -> bool {
    match host {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost") || domain.to_ascii_lowercase().ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn valid_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| format!("{} is not a web address.", url.chars().take(80).collect::<String>()))?;
    match parsed.scheme() {
        "https" => {
            if parsed.host().is_none() {
                return Err(format!("{} is not a web address.", url.chars().take(80).collect::<String>()));
            }
            Ok(())
        }
        "http" => {
            if !is_loopback_host(parsed.host()) {
                return Err("Non-local base URLs must use https:// (plain http:// is only allowed for localhost).".into());
            }
            Ok(())
        }
        _ => Err("The base URL must start with http:// or https://.".into()),
    }
}

/// Connect `id` with `key` (or, for Ollama, its server), after its provider
/// accepted the key. `base_url`: `Some("")` clears an earlier one, `None`
/// leaves it. A provider without a model list gets an empty one, so the
/// picker offers nothing from it until a model is added.
pub fn connect_in(paths: &Paths, id: &str, key: &str, base_url: Option<&str>) -> Result<ConnectResult, String> {
    let (provider, npm) = find_provider(paths, id)?;
    let key = key.trim();
    if key.is_empty() && !provider.local { return Err(format!("Paste a {} API key first.", provider.name)); }
    let base = base_url.map(str::trim).filter(|url| !url.is_empty());
    if let Some(url) = base { valid_url(url)?; }
    // Refuse before anything is written: a broken config or a refused key leaves both files as they were.
    let config = read_config(paths);
    if let Some(problem) = config.problem { return Err(problem); }
    // A local server writes no key, so a broken key file doesn't stop it.
    if !provider.local { read_auth(paths)?; }
    // Left unchanged (None), the key is checked where OpenCode will send it: the
    // address already in the config, not the provider's own, which a gateway's
    // key must never reach.
    let configured = config.value.get("provider").and_then(|providers| providers.get(id)).and_then(|entry| entry.pointer("/options/baseURL")).and_then(Value::as_str).map(str::to_owned);
    let check_at = if base_url.is_some() { base } else { configured.as_deref() };
    let check = check_key(&provider, npm.as_deref(), key, check_at)?;
    if !provider.local {
        // Read again after the check, which can take seconds: a running OpenCode may
        // have refreshed a sign-in meanwhile, and the snapshot from before would revert it.
        update_auth(paths, |auth| { auth.insert(id.to_owned(), json!({"type": "api", "key": key})); })?;
    }
    edit_config(paths, |config| {
        let entry = provider_entry(config, id)?;
        if provider.local {
            entry.insert("npm".into(), json!("@ai-sdk/openai-compatible"));
            entry.entry("name").or_insert_with(|| json!("Ollama (local)"));
            entry.entry("options").or_insert_with(|| json!({})).as_object_mut().ok_or("The provider’s \"options\" is not an object.")?
                .insert("baseURL".into(), json!(check_at.unwrap_or(OLLAMA_URL)));
        } else if base_url.is_some() {
            let options = entry.entry("options").or_insert_with(|| json!({})).as_object_mut().ok_or("The provider’s \"options\" is not an object.")?;
            match base { Some(url) => { options.insert("baseURL".into(), json!(url)); } None => { options.remove("baseURL"); } }
        }
        entry.entry("whitelist").or_insert_with(|| json!([]));
        Ok(())
    })?;
    Ok(ConnectResult { overview: overview_in(paths, false), check })
}

/// Forget `id`'s key, from auth.json and the config file, and a server of
/// its own (Ollama's or one set up by hand). Its model list and a gateway
/// address set for a catalogue provider stay, for when it is connected again.
pub fn disconnect_in(paths: &Paths, id: &str) -> Result<Overview, String> {
    let config = read_config(paths);
    // A config that couldn't be read may hold this provider's key; nothing is decided from its empty stand-in.
    if !config.known { return Err(config.problem.unwrap_or_default()); }
    // Likewise a key file that can't be read may hold it: Disconnect must not say it
    // is gone while OpenCode still has it.
    let in_auth = read_auth(paths)?.contains_key(id);
    let entry = config.value.get("provider").and_then(|providers| providers.get(id)).cloned().unwrap_or(Value::Null);
    let has_key = entry.pointer("/options/apiKey").is_some();
    let maybe_server = entry.get("npm").is_some() && entry.pointer("/options/baseURL").is_some();
    // The providers the list was built from: OpenCode's copy or the one downloaded this run, never a new download.
    let catalogue = catalog_value(paths, false);
    let remove_server = maybe_server && match &catalogue {
        Ok(catalog) => own_server(id, &entry, catalog),
        // Without the catalogue a hand-made server can't be told for sure from a gateway, which
        // must stay: a known provider's keys still go, the address and SDK are left for a later
        // Disconnect.
        Err(_) => id == OLLAMA,
    };
    // The list shows a server the built-in ids don't know as one of its own. Removing its keys
    // alone would leave it listed, and its address may yet be a gateway of a newer provider.
    let listed_as_server = catalogue.is_err() && !remove_server && own_server(id, &entry, &Map::new());
    let edits_config = has_key || remove_server;
    if listed_as_server || (!in_auth && !edits_config) {
        if let (Err(problem), true) = (&catalogue, maybe_server) {
            return Err(format!("{problem} Without it TerminalX can’t tell whether {id}’s address is a server set up by hand or a gateway to keep, so nothing was removed. Try again once OpenCode has its provider list, or remove it from {} yourself.", shown(&config.path)));
        }
        return Ok(overview_in(paths, false));
    }
    if edits_config {
        // Both files change or neither: the config first (it may refuse, say for comments),
        // then auth.json, with the config's earlier text put back if that write fails.
        if let Some(problem) = config.problem { return Err(problem); }
        let before = std::fs::read(&config.path).map_err(|error| format!("Couldn’t read {}: {error}", shown(&config.path)))?;
        edit_config(paths, |config| {
            let entry = provider_entry(config, id)?;
            if remove_server { entry.remove("npm"); }
            if let Some(options) = entry.get_mut("options").and_then(Value::as_object_mut) {
                options.remove("apiKey");
                if remove_server { options.remove("baseURL"); }
            }
            Ok(())
        })?;
        if in_auth {
            if let Err(problem) = update_auth(paths, |auth| { auth.remove(id); }) {
                return Err(match crate::store::write_atomic(&config.path, &before) {
                    Ok(()) => format!("{problem} Nothing was disconnected."),
                    Err(error) => format!("{problem} The config file changed already and couldn’t be put back ({error:#}); {}", restore_hint(id, &entry, remove_server, &config.path)),
                });
            }
        }
    } else {
        update_auth(paths, |auth| { auth.remove(id); })?;
    }
    Ok(overview_in(paths, false))
}

/// How to undo a Disconnect whose config edit stuck while its key stayed in
/// auth.json. The form connects a catalogue provider or Ollama again; a server
/// set up by hand it can't, so its SDK and address are named instead (never
/// its key, which auth.json still holds).
fn restore_hint(id: &str, entry: &Value, removed_server: bool, config_path: &Path) -> String {
    if !removed_server || id == OLLAMA { return format!("connect {id} again to restore it."); }
    let npm = entry.get("npm").and_then(Value::as_str).unwrap_or_default();
    let base = entry.pointer("/options/baseURL").and_then(Value::as_str).unwrap_or_default();
    // An address may carry a sign-in (https://user:secret@host); the message never shows it.
    let base = match url::Url::parse(base) {
        Ok(mut url) if !url.username().is_empty() || url.password().is_some() => {
            let _ = url.set_password(None);
            let _ = url.set_username("");
            url.to_string()
        }
        _ => base.to_owned(),
    };
    format!("to restore it, set {id}’s \"npm\" back to \"{npm}\" and its \"options\" › \"baseURL\" to \"{base}\" in {}.", shown(config_path))
}

fn valid_model(model: &str) -> Result<&str, String> {
    let model = model.trim();
    if model.is_empty() { return Err("Type a model ID, such as deepseek/deepseek-v4.".into()); }
    if model.len() > 200 || model.chars().any(|c| c.is_whitespace() || c.is_control()) { return Err("A model ID has no spaces.".into()); }
    Ok(model)
}

/// Offer `model` of `provider` in the picker. A model the catalogue does not
/// list is described to OpenCode in the config file too, so it can run it.
pub fn add_model_in(paths: &Paths, provider: &str, model: &str) -> Result<Overview, String> {
    let model = valid_model(model)?;
    let known = provider != OLLAMA && catalog_value(paths, true).ok()
        .is_some_and(|catalog| catalog.get(provider).and_then(|value| value.get("models")).and_then(|models| models.get(model)).is_some());
    edit_config(paths, |config| {
        let entry = provider_entry(config, provider)?;
        let list = entry.entry("whitelist").or_insert_with(|| json!([])).as_array_mut().ok_or("The provider’s \"whitelist\" is not a list.")?;
        if !list.iter().any(|item| item.as_str() == Some(model)) { list.push(json!(model)); }
        if !known {
            entry.entry("models").or_insert_with(|| json!({})).as_object_mut().ok_or("The provider’s \"models\" is not an object.")?
                .entry(model.to_owned()).or_insert_with(|| json!({}));
        }
        Ok(())
    })?;
    Ok(overview_in(paths, false))
}

/// Take `model` out of the picker, and out of the config file's own models
/// when it was described there with nothing else.
pub fn remove_model_in(paths: &Paths, provider: &str, model: &str) -> Result<Overview, String> {
    edit_config(paths, |config| {
        let entry = provider_entry(config, provider)?;
        if let Some(list) = entry.get_mut("whitelist").and_then(Value::as_array_mut) { list.retain(|item| item.as_str() != Some(model)); }
        if let Some(models) = entry.get_mut("models").and_then(Value::as_object_mut) {
            if models.get(model).is_some_and(|described| described.as_object().is_some_and(Map::is_empty)) { models.remove(model); }
            if models.is_empty() { entry.remove("models"); }
        }
        Ok(())
    })?;
    Ok(overview_in(paths, false))
}

/// The newest log OpenCode wrote, else its log folder.
pub fn latest_log(paths: &Paths) -> Option<PathBuf> {
    let dir = paths.log_dir();
    let mut logs: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&dir).ok()?.flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
        .filter_map(|entry| { let meta = entry.metadata().ok().filter(|meta| meta.len() > 0)?; Some((meta.modified().ok()?, entry.path())) })
        .collect();
    logs.sort();
    logs.pop().map(|(_, path)| path).or_else(|| dir.is_dir().then_some(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths { config_dir: dir.path().join("config"), data_dir: dir.path().join("data"), cache_dir: dir.path().join("cache") };
        std::fs::create_dir_all(&paths.cache_dir).unwrap();
        std::fs::write(paths.catalog_file(), json!({
            "anthropic": {"id": "anthropic", "name": "Anthropic", "env": ["ANTHROPIC_API_KEY"], "npm": "@ai-sdk/anthropic", "models": {
                "claude-sonnet-4-5": {"id": "claude-sonnet-4-5", "name": "Claude Sonnet 4.5"}, "claude-opus-4-5": {"id": "claude-opus-4-5", "name": "Claude Opus 4.5"}}},
            "openrouter": {"id": "openrouter", "name": "OpenRouter", "env": ["OPENROUTER_API_KEY"], "npm": "@openrouter/ai-sdk-provider", "api": "https://openrouter.ai/api/v1", "models": {
                "openai/gpt-5": {"id": "openai/gpt-5", "name": "GPT-5"}}},
            "weird": {"id": "weird", "name": "Weird", "env": ["WEIRD_KEY"], "npm": "weird-sdk", "models": {}},
        }).to_string()).unwrap();
        (dir, paths)
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_are_read() {
        let (plain, commented) = strip_jsonc("{\n  // a note\n  \"a\": \"http://x//y\", /* b */\n  \"list\": [1, 2,],\n}");
        assert!(commented);
        assert_eq!(serde_json::from_str::<Value>(&plain).unwrap(), json!({"a": "http://x//y", "list": [1, 2]}));
        let (plain, commented) = strip_jsonc(r#"{"quote": "a \" // not a comment"}"#);
        assert!(!commented);
        assert_eq!(serde_json::from_str::<Value>(&plain).unwrap()["quote"], r#"a " // not a comment"#);
    }

    #[test]
    fn a_key_is_shown_by_its_ends_only() {
        assert_eq!(mask("sk-or-v1-0123456789abcdef8c1e"), "sk-or-••••••••8c1e");
        assert_eq!(mask("gsk_8f2c0123456789abcdef"), "gsk_••••••••cdef");
        assert_eq!(mask("sk-ant-api03-0123456789abcdef"), "sk-ant-••••••••cdef");
        assert_eq!(mask("plainkey0123456789"), "plai••••••••6789");
        assert_eq!(mask("short"), "••••••••");
    }

    /// The flow of screens 10.15 and 10.16 on OpenCode's own files: a key a
    /// provider cannot be asked about is kept, its provider starts with no
    /// models in the picker, and added models are what the picker offers.
    #[test]
    fn connecting_a_provider_and_adding_models_writes_opencodes_own_files() {
        let (_dir, paths) = paths();
        let empty = overview_in(&paths, false);
        assert!(empty.connected.is_empty() && empty.models.is_empty());
        assert!(empty.catalog.iter().any(|provider| provider.id == OLLAMA && provider.local), "Ollama is offered though models.dev lacks it");

        let result = connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap();
        assert!(matches!(result.check, KeyCheck::NotChecked { .. }));
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth, json!({"weird": {"type": "api", "key": "weird-key-0123456789"}}));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(paths.auth_file()).unwrap().permissions().mode() & 0o777, 0o600);
            // A key file left readable by others is made owner-only before new keys go in.
            std::fs::set_permissions(paths.auth_file(), std::fs::Permissions::from_mode(0o644)).unwrap();
            connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap();
            assert_eq!(std::fs::metadata(paths.auth_file()).unwrap().permissions().mode() & 0o777, 0o600);
            let left: Vec<_> = std::fs::read_dir(paths.auth_file().parent().unwrap()).unwrap().flatten().map(|entry| entry.file_name()).collect();
            assert_eq!(left, vec![std::ffi::OsString::from("auth.json")], "no temp file is left beside it");
        }
        let weird = &result.overview.connected[0];
        assert_eq!((weird.id.as_str(), weird.auth.as_str(), weird.unlisted), ("weird", "api", false));
        assert!(weird.models.is_empty(), "nothing is in the picker until a model is added");
        assert!(!weird.masked_key.as_deref().unwrap().contains("0123456789"));

        let added = add_model_in(&paths, "weird", "weird/large-1").unwrap();
        assert_eq!(added.models, vec![PickerModel { id: "weird/weird/large-1".into(), provider: "weird".into(), provider_name: "Weird".into(), model: "weird/large-1".into(), name: "weird/large-1".into() }]);
        add_model_in(&paths, "weird", "weird/large-1").unwrap();
        let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
        assert_eq!(config["$schema"], "https://opencode.ai/config.json");
        assert_eq!(config["provider"]["weird"]["whitelist"], json!(["weird/large-1"]), "added once");
        assert_eq!(config["provider"]["weird"]["models"], json!({"weird/large-1": {}}), "a model the catalogue lacks is described");

        let removed = remove_model_in(&paths, "weird", "weird/large-1").unwrap();
        assert!(removed.models.is_empty());
        let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
        assert_eq!(config["provider"]["weird"], json!({"whitelist": []}));

        let gone = disconnect_in(&paths, "weird").unwrap();
        assert!(gone.connected.is_empty());
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap().trim(), "{}");
    }

    #[test]
    fn a_known_model_gets_its_catalogue_name_and_an_existing_login_is_kept() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), json!({"anthropic": {"type": "oauth", "refresh": "r", "access": "a", "expires": 1}}).to_string()).unwrap();
        let before = overview_in(&paths, false);
        assert_eq!(before.connected.len(), 1);
        assert_eq!((before.connected[0].auth.as_str(), before.connected[0].unlisted, before.connected[0].catalog_models), ("oauth", true, 2));
        assert_eq!(before.connected[0].masked_key, None, "a sign-in has no key to show");
        let after = add_model_in(&paths, "anthropic", "claude-opus-4-5").unwrap();
        assert_eq!(after.models.iter().map(|model| (model.id.as_str(), model.name.as_str())).collect::<Vec<_>>(), vec![("anthropic/claude-opus-4-5", "Claude Opus 4.5")]);
        let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
        assert!(config["provider"]["anthropic"].get("models").is_none(), "a catalogue model needs no description");
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth["anthropic"]["type"], "oauth", "the sign-in OpenCode made is untouched");
    }

    #[test]
    fn a_config_file_with_comments_is_read_but_never_rewritten() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        let file = paths.config_dir.join("opencode.jsonc");
        let original = "{\n  // mine\n  \"provider\": {\"anthropic\": {\"whitelist\": [\"claude-sonnet-4-5\",],},},\n}\n";
        std::fs::write(&file, original).unwrap();
        assert_eq!(paths.config_file(), file, "the .jsonc file wins, as OpenCode reads it last");
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), json!({"anthropic": {"type": "api", "key": "sk-ant-0123456789abcdef"}}).to_string()).unwrap();
        let overview = overview_in(&paths, false);
        assert_eq!(overview.models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), vec!["anthropic/claude-sonnet-4-5"]);
        assert!(overview.config_problem.as_deref().is_some_and(|problem| problem.contains("has comments")));
        assert!(add_model_in(&paths, "anthropic", "claude-opus-4-5").unwrap_err().contains("has comments"));
        assert!(connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap_err().contains("has comments"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        assert!(!read_auth(&paths).unwrap().contains_key("weird"), "a refused connect writes no key");
    }

    /// A gateway on this Mac that answers one request and says what was asked.
    fn gateway() -> (String, std::thread::JoinHandle<String>) { gateway_during(|| {}) }

    /// How long a test gateway waits for its request before failing the test.
    const GATEWAY_WAIT: Duration = Duration::from_secs(10);

    /// The next connection to `listener` at `url`, or a panic naming `url` once
    /// [`GATEWAY_WAIT`] passes with none: a key sent elsewhere fails the test
    /// instead of leaving it waiting forever.
    fn accept_within(listener: &std::net::TcpListener, url: &str) -> std::net::TcpStream {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + GATEWAY_WAIT;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    // Some systems hand the accepted socket the listener's non-blocking mode.
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(GATEWAY_WAIT)).unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(std::time::Instant::now() < deadline, "no request reached the gateway at {url} within {GATEWAY_WAIT:?}: the key was sent somewhere else, or not at all");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("the gateway at {url} couldn’t take a connection: {error}"),
            }
        }
    }

    /// [`gateway`], running `during` after the request arrived and before it is answered.
    fn gateway_during(during: impl FnOnce() + Send + 'static) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let at = url.clone();
        let served = std::thread::spawn(move || {
            let stream = accept_within(&listener, &at);
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" { break; }
                request.push_str(&line);
            }
            during();
            let mut stream = stream;
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
            request
        });
        (url, served)
    }

    #[test]
    fn replacing_a_key_checks_it_at_the_configured_gateway_and_keeps_it() {
        let (_dir, paths) = paths();
        let (url, served) = gateway();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        std::fs::write(paths.config_file(), json!({"provider": {"openrouter": {"options": {"baseURL": url}, "whitelist": []}}}).to_string()).unwrap();
        let before = overview_in(&paths, false);
        assert_eq!(before.catalog.iter().find(|provider| provider.id == "openrouter").unwrap().base_url.as_deref(), Some(url.as_str()), "a reconnect starts from the gateway");

        let result = connect_in(&paths, "openrouter", "gateway-key-0123456789", None).unwrap();
        assert!(matches!(result.check, KeyCheck::Accepted));
        let request = served.join().unwrap();
        assert!(request.starts_with("GET /v1/key "), "{request}");
        assert!(request.contains("Bearer gateway-key-0123456789"), "the key went to the gateway, not openrouter.ai");
        assert_eq!(result.overview.connected[0].base_url.as_deref(), Some(url.as_str()), "left unchanged, the gateway stays");

        // Disconnecting a catalogue provider keeps its gateway for next time.
        let after = disconnect_in(&paths, "openrouter").unwrap();
        assert!(after.connected.is_empty());
        assert_eq!(after.catalog.iter().find(|provider| provider.id == "openrouter").unwrap().base_url.as_deref(), Some(url.as_str()));
    }

    /// A gateway on this Mac that answers `count` requests, one after another, and says what each asked.
    fn gateway_for(count: usize) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let at = url.clone();
        let served = std::thread::spawn(move || (0..count).map(|_| {
            let mut stream = accept_within(&listener, &at);
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" { break; }
                request.push_str(&line);
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
            request
        }).collect());
        (url, served)
    }

    /// Issue #1321: a catalogue provider connected through a custom gateway,
    /// then disconnected, reconnects through that gateway when the address is
    /// left as the form shows it, and loses it only when cleared on purpose.
    #[test]
    fn a_gateway_survives_disconnect_and_reconnect_until_cleared() {
        let (_dir, paths) = paths();
        let (gateway, gateway_served) = gateway_for(2);
        let (catalogue, catalogue_served) = gateway_for(1);
        std::fs::write(paths.catalog_file(), json!({
            "acme": {"id": "acme", "name": "Acme", "env": ["ACME_API_KEY"], "npm": "@ai-sdk/openai", "api": catalogue, "models": {}},
        }).to_string()).unwrap();
        let saved_base = |paths: &Paths| -> Option<String> {
            let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
            config.pointer("/provider/acme/options/baseURL").and_then(Value::as_str).map(str::to_owned)
        };

        connect_in(&paths, "acme", "acme-key-first-0123", Some(&gateway)).unwrap();
        assert_eq!(saved_base(&paths).as_deref(), Some(gateway.as_str()));

        let gone = disconnect_in(&paths, "acme").unwrap();
        assert!(gone.connected.is_empty() && !read_auth(&paths).unwrap().contains_key("acme"));
        assert_eq!(saved_base(&paths).as_deref(), Some(gateway.as_str()), "disconnecting keeps the gateway");
        let offered = gone.catalog.iter().find(|provider| provider.id == "acme").unwrap();
        assert_eq!(offered.base_url.as_deref(), Some(gateway.as_str()), "the reconnect form starts from the gateway");

        // The address left as the form showed it (None): checked at, and kept on, the gateway.
        let back = connect_in(&paths, "acme", "acme-key-again-4567", None).unwrap();
        assert!(matches!(back.check, KeyCheck::Accepted));
        assert_eq!(saved_base(&paths).as_deref(), Some(gateway.as_str()), "reconnecting kept the gateway");
        assert_eq!(back.overview.connected[0].base_url.as_deref(), Some(gateway.as_str()));
        let asked = gateway_served.join().unwrap();
        assert!(asked[0].contains("Bearer acme-key-first-0123") && asked[1].contains("Bearer acme-key-again-4567"), "{asked:?}");

        // Cleared on purpose (""): only now is the gateway dropped, and the key goes to the catalogue's address.
        disconnect_in(&paths, "acme").unwrap();
        let direct = connect_in(&paths, "acme", "acme-key-direct-890", Some("")).unwrap();
        assert!(matches!(direct.check, KeyCheck::Accepted));
        assert!(catalogue_served.join().unwrap()[0].contains("Bearer acme-key-direct-890"));
        assert_eq!(saved_base(&paths), None, "cleared, no base URL is kept");
    }

    /// An address that must never be asked: it takes connections but answers none.
    fn untouched() -> (String, std::net::TcpListener) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        (format!("http://{}/v1", listener.local_addr().unwrap()), listener)
    }

    fn never_asked(listener: &std::net::TcpListener, what: &str) {
        assert!(matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock), "{what} was sent the key");
    }

    /// Issue #1319, for a catalogue provider checked at `/models`: the key is
    /// checked where it will be saved, whether the address is left alone, new,
    /// or cleared, and no other address ever sees it.
    #[test]
    fn a_replacement_key_is_checked_only_where_it_will_be_sent() {
        let (_dir, paths) = paths();
        let (catalogue, catalogue_listener) = untouched();
        std::fs::write(paths.catalog_file(), json!({
            "acme": {"id": "acme", "name": "Acme", "env": ["ACME_API_KEY"], "npm": "@ai-sdk/openai", "api": catalogue, "models": {}},
        }).to_string()).unwrap();
        let saved_base = |paths: &Paths| -> Option<String> {
            let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
            config.pointer("/provider/acme/options/baseURL").and_then(Value::as_str).map(str::to_owned)
        };

        // Replace with the base URL left as saved: the saved gateway is asked, not the catalogue's address.
        let (saved, served) = gateway();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        std::fs::write(paths.config_file(), json!({"provider": {"acme": {"options": {"baseURL": saved}, "whitelist": []}}}).to_string()).unwrap();
        let result = connect_in(&paths, "acme", "acme-key-0123456789", None).unwrap();
        assert!(matches!(result.check, KeyCheck::Accepted));
        let request = served.join().unwrap();
        assert!(request.starts_with("GET /v1/models "), "{request}");
        assert!(request.contains("Bearer acme-key-0123456789"));
        never_asked(&catalogue_listener, "the catalogue address");
        assert_eq!(saved_base(&paths).as_deref(), Some(saved.as_str()), "left unchanged, the gateway stays");

        // A new base URL: it alone is asked, and it is what is saved.
        let (new, served) = gateway();
        let replaced = connect_in(&paths, "acme", "acme-key-9876543210", Some(&format!("  {new}  "))).unwrap();
        assert!(matches!(replaced.check, KeyCheck::Accepted), "the new gateway didn’t accept the key, so it was checked elsewhere: {:?}", replaced.check);
        assert!(served.join().unwrap().contains("Bearer acme-key-9876543210"));
        never_asked(&catalogue_listener, "the catalogue address");
        assert_eq!(saved_base(&paths).as_deref(), Some(new.as_str()));

        // Cleared on purpose: the catalogue's own address is asked, and nothing is saved in its place.
        let (catalogue, served) = gateway();
        std::fs::write(paths.catalog_file(), json!({
            "acme": {"id": "acme", "name": "Acme", "env": ["ACME_API_KEY"], "npm": "@ai-sdk/openai", "api": catalogue, "models": {}},
        }).to_string()).unwrap();
        let cleared = connect_in(&paths, "acme", "acme-key-0000000000", Some("")).unwrap();
        assert!(matches!(cleared.check, KeyCheck::Accepted));
        assert!(served.join().unwrap().contains("Bearer acme-key-0000000000"), "cleared, the key is checked at the catalogue's address");
        assert_eq!(saved_base(&paths), None, "cleared, no base URL is kept");
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth["acme"], json!({"type": "api", "key": "acme-key-0000000000"}));
    }

    #[test]
    fn a_key_file_that_cannot_be_read_is_never_overwritten() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        // As a half-written refresh of a sign-in would leave it.
        let torn = "{\"anthropic\": {\"type\": \"oauth\", \"refresh\": \"r\", \"acc";
        std::fs::write(paths.auth_file(), torn).unwrap();
        let overview = overview_in(&paths, false);
        assert!(overview.auth_problem.as_deref().is_some_and(|problem| problem.contains("isn’t valid JSON")), "{:?}", overview.auth_problem);
        assert!(connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap_err().contains("won’t change it"));
        assert!(disconnect_in(&paths, "anthropic").unwrap_err().contains("won’t change it"));
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), torn);
        assert!(!paths.config_file().exists(), "nothing else was written either");

        // OpenCode truncates the file before writing it, so an empty one is a write in progress, not "no keys".
        std::fs::write(paths.auth_file(), "").unwrap();
        assert!(overview_in(&paths, false).auth_problem.as_deref().is_some_and(|problem| problem.contains("is empty")));
        // Neither JSON that isn't an object, nor a file that can't be read at all.
        std::fs::write(paths.auth_file(), "[]").unwrap();
        assert!(connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap_err().contains("isn’t a JSON object"));
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), "[]");
        std::fs::remove_file(paths.auth_file()).unwrap();
        std::fs::create_dir(paths.auth_file()).unwrap();
        assert!(connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap_err().starts_with("Couldn’t read"));
        // Gone altogether is no keys yet.
        std::fs::remove_dir(paths.auth_file()).unwrap();
        assert!(overview_in(&paths, false).auth_problem.is_none());
    }

    #[test]
    fn a_sign_in_refreshed_during_the_key_check_is_kept() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let old = json!({"anthropic": {"type": "oauth", "refresh": "r1", "access": "a1", "expires": 1}});
        std::fs::write(paths.auth_file(), old.to_string()).unwrap();
        // While the key is being checked, OpenCode rotates the Anthropic sign-in.
        let refreshed = json!({"anthropic": {"type": "oauth", "refresh": "r2", "access": "a2", "expires": 2}});
        let (file, during) = (paths.auth_file(), refreshed.to_string());
        let (url, served) = gateway_during(move || std::fs::write(file, during).unwrap());
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        std::fs::write(paths.config_file(), json!({"provider": {"openrouter": {"options": {"baseURL": url}}}}).to_string()).unwrap();
        connect_in(&paths, "openrouter", "gateway-key-0123456789", None).unwrap();
        served.join().unwrap();
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth["anthropic"], refreshed["anthropic"], "the rotated token is not put back to the old one");
        assert_eq!(auth["openrouter"], json!({"type": "api", "key": "gateway-key-0123456789"}));
    }

    #[test]
    fn connecting_keeps_every_other_providers_login() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let others = json!({
            "anthropic": {"type": "oauth", "refresh": "r", "access": "a", "expires": 1},
            "openrouter": {"type": "api", "key": "sk-or-0123456789abcdef"},
            "custom": {"type": "wellknown", "key": "k", "token": "t"},
        });
        std::fs::write(paths.auth_file(), others.to_string()).unwrap();
        connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap();
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        for (id, entry) in others.as_object().unwrap() { assert_eq!(&auth[id], entry, "{id} is kept as it was"); }
        assert_eq!(auth["weird"], json!({"type": "api", "key": "weird-key-0123456789"}));
        disconnect_in(&paths, "weird").unwrap();
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth, others, "disconnecting one removes only that one");
    }

    #[test]
    fn a_sign_in_refreshed_just_before_the_write_is_kept() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), json!({"anthropic": {"type": "oauth", "refresh": "r1", "access": "a1", "expires": 1}}).to_string()).unwrap();
        // OpenCode rotates the sign-in after TerminalX read the file and before it writes.
        let refreshed = json!({"type": "oauth", "refresh": "r2", "access": "a2", "expires": 2});
        let (file, during) = (paths.auth_file(), json!({"anthropic": refreshed}).to_string());
        let mut once = Some(move || std::fs::write(&file, &during).unwrap());
        BEFORE_AUTH_WRITE.with(|hook| *hook.borrow_mut() = Some(Box::new(move || if let Some(write) = once.take() { write() })));
        let connected = connect_in(&paths, "weird", "weird-key-0123456789", None);
        BEFORE_AUTH_WRITE.with(|hook| *hook.borrow_mut() = None);
        connected.unwrap();
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth["anthropic"], refreshed, "the rotated token is not put back to the old one");
        assert_eq!(auth["weird"], json!({"type": "api", "key": "weird-key-0123456789"}));
    }

    /// Issue #1374: Disconnect decided the key was there from an earlier read; if
    /// OpenCode drops it, or the whole file, before the key file is read again,
    /// nothing is written and the file stays as OpenCode left it.
    #[test]
    fn disconnect_writes_nothing_when_the_key_went_meanwhile() {
        for gone_file in [false, true] {
            let (_dir, paths) = paths();
            std::fs::create_dir_all(&paths.data_dir).unwrap();
            std::fs::write(paths.auth_file(), json!({"weird": {"type": "api", "key": "weird-key-0123456789"}, "anthropic": {"type": "oauth", "refresh": "r1"}}).to_string()).unwrap();
            // Compact, as TerminalX never writes it: any rewrite would change these bytes.
            let left = json!({"anthropic": {"type": "oauth", "refresh": "r2"}}).to_string();
            let (file, during) = (paths.auth_file(), left.clone());
            let mut once = Some(move || if gone_file { std::fs::remove_file(&file).unwrap() } else { std::fs::write(&file, &during).unwrap() });
            BEFORE_AUTH_WRITE.with(|hook| *hook.borrow_mut() = Some(Box::new(move || if let Some(change) = once.take() { change() })));
            let disconnected = disconnect_in(&paths, "weird");
            BEFORE_AUTH_WRITE.with(|hook| *hook.borrow_mut() = None);
            let overview = disconnected.unwrap();
            assert!(!overview.connected.iter().any(|provider| provider.id == "weird"));
            if gone_file {
                assert!(!paths.auth_file().exists(), "a deleted key file is not made again");
            } else {
                assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), left, "the file is left as OpenCode wrote it, other sign-ins and all");
            }
        }
    }

    /// Issue #1373: a refresh landing after the new key file was serialized and
    /// written beside the old one, the point the old check came too early for,
    /// is seen before the swap, so the rotated sign-in is kept.
    #[test]
    fn a_sign_in_refreshed_while_the_new_file_is_written_is_kept() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), json!({"anthropic": {"type": "oauth", "refresh": "r1", "access": "a1", "expires": 1}}).to_string()).unwrap();
        let refreshed = json!({"type": "oauth", "refresh": "r2", "access": "a2", "expires": 2});
        let (file, during) = (paths.auth_file(), json!({"anthropic": refreshed}).to_string());
        let mut once = Some(move || std::fs::write(&file, &during).unwrap());
        BEFORE_AUTH_REPLACE.with(|hook| *hook.borrow_mut() = Some(Box::new(move || if let Some(write) = once.take() { write() })));
        let connected = connect_in(&paths, "weird", "weird-key-0123456789", None);
        BEFORE_AUTH_REPLACE.with(|hook| *hook.borrow_mut() = None);
        connected.unwrap();
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert_eq!(auth["anthropic"], refreshed, "the rotated token is not put back to the old one");
        assert_eq!(auth["weird"], json!({"type": "api", "key": "weird-key-0123456789"}));
        let left: Vec<_> = std::fs::read_dir(&paths.data_dir).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("auth.json")], "the dropped new file is not left beside it");
    }

    #[test]
    fn a_key_file_that_keeps_changing_is_left_as_its_writer_left_it() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), json!({"anthropic": {"type": "oauth", "refresh": "r0"}}).to_string()).unwrap();
        let file = paths.auth_file();
        let mut turn = 0;
        BEFORE_AUTH_WRITE.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
            turn += 1;
            std::fs::write(&file, json!({"anthropic": {"type": "oauth", "refresh": format!("r{turn}")}}).to_string()).unwrap();
        })));
        let refused = connect_in(&paths, "weird", "weird-key-0123456789", None);
        BEFORE_AUTH_WRITE.with(|hook| *hook.borrow_mut() = None);
        assert!(refused.unwrap_err().contains("kept changing"));
        let last = json!({"anthropic": {"type": "oauth", "refresh": format!("r{AUTH_UPDATES}")}}).to_string();
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), last, "the other writer's last bytes stand");
        assert!(!paths.config_file().exists(), "nothing else was written either");
    }

    #[test]
    fn a_config_file_that_cannot_be_read_is_not_taken_as_missing() {
        let (_dir, paths) = paths();
        // A provider whose key would be checked at its catalogue address, here on this Mac.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut catalog: Value = serde_json::from_str(&std::fs::read_to_string(paths.catalog_file()).unwrap()).unwrap();
        catalog["probed"] = json!({"id": "probed", "name": "Probed", "env": ["PROBED_KEY"], "npm": "@ai-sdk/openai-compatible", "api": format!("http://{}/v1", listener.local_addr().unwrap()), "models": {}});
        std::fs::write(paths.catalog_file(), catalog.to_string()).unwrap();
        assert!(probe_for("probed", Some("@ai-sdk/openai-compatible"), catalog["probed"]["api"].as_str(), None).is_some(), "this provider's key would be checked");
        std::fs::create_dir_all(paths.config_file()).unwrap();
        assert!(connect_in(&paths, "probed", "probed-key-0123456789", None).unwrap_err().starts_with("Couldn’t read"));
        assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock, "the key went nowhere");
        let overview = overview_in(&paths, false);
        assert!(overview.config_exists);
        assert!(overview.config_problem.as_deref().is_some_and(|problem| problem.starts_with("Couldn’t read")), "{:?}", overview.config_problem);
        assert!(connect_in(&paths, "weird", "weird-key-0123456789", None).unwrap_err().starts_with("Couldn’t read"));
        assert!(add_model_in(&paths, "weird", "weird/large-1").unwrap_err().starts_with("Couldn’t read"));
        assert!(paths.config_file().is_dir() && !paths.auth_file().exists(), "nothing was written");
    }

    #[test]
    fn a_broken_key_file_blocks_only_what_may_touch_a_key() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), "{\"anthropic\": ").unwrap();
        // Ollama keeps no key.
        let (url, served) = gateway();
        let result = connect_in(&paths, OLLAMA, "", Some(&url)).unwrap();
        served.join().unwrap();
        assert!(result.overview.connected.iter().any(|provider| provider.id == OLLAMA));
        // Disconnect can't tell whether that file holds the provider's key, so it waits for a readable one.
        assert!(disconnect_in(&paths, OLLAMA).unwrap_err().contains("isn’t valid JSON"));
        assert!(overview_in(&paths, false).connected.iter().any(|provider| provider.id == OLLAMA), "nothing was half done");
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), "{\"anthropic\": ");
    }

    #[test]
    fn disconnect_never_says_a_key_is_gone_while_an_unreadable_key_file_may_hold_it() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        let config = json!({"provider": {"openrouter": {"options": {"apiKey": "sk-or-0123456789abcdef"}}}}).to_string();
        std::fs::write(paths.config_file(), &config).unwrap();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), "{\"openrouter\": {\"type\": \"api\", \"ke").unwrap();
        assert!(disconnect_in(&paths, "openrouter").unwrap_err().contains("isn’t valid JSON"));
        assert_eq!(std::fs::read_to_string(paths.config_file()).unwrap(), config, "the config key stays until both can go");
    }

    #[test]
    fn disconnect_without_the_catalogue_removes_the_keys_and_keeps_the_address() {
        let (_dir, paths) = paths();
        std::fs::remove_file(paths.catalog_file()).unwrap();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        std::fs::write(paths.config_file(), json!({"provider": {"openrouter": {"npm": "@ai-sdk/openai-compatible",
            "options": {"baseURL": "https://gateway.example.internal/v1", "apiKey": "gw-0123456789abcdef"}}}}).to_string()).unwrap();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        std::fs::write(paths.auth_file(), json!({"openrouter": {"type": "api", "key": "sk-or-0123456789abcdef"}, "anthropic": {"type": "oauth", "refresh": "r", "access": "a", "expires": 1}}).to_string()).unwrap();
        let after = disconnect_in(&paths, "openrouter").unwrap();
        assert!(!after.connected.iter().any(|provider| provider.id == "openrouter"), "a gateway without keys doesn't look connected");
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(paths.auth_file()).unwrap()).unwrap();
        assert!(auth.get("openrouter").is_none() && auth.get("anthropic").is_some());
        let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
        let kept = &config["provider"]["openrouter"];
        assert!(kept["options"].get("apiKey").is_none());
        assert_eq!((kept["npm"].as_str(), kept["options"]["baseURL"].as_str()), (Some("@ai-sdk/openai-compatible"), Some("https://gateway.example.internal/v1")), "it may be a gateway, so it stays");
    }

    #[test]
    fn disconnect_without_the_catalogue_says_why_when_it_can_remove_nothing() {
        let (_dir, paths) = paths();
        std::fs::remove_file(paths.catalog_file()).unwrap();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        let config = json!({"provider": {"lab-server": {"npm": "@ai-sdk/openai-compatible", "name": "Lab server", "options": {"baseURL": "http://127.0.0.1:1234/v1"}, "models": {"qwen3": {}}}}}).to_string();
        std::fs::write(paths.config_file(), &config).unwrap();
        assert!(overview_in(&paths, false).connected.iter().any(|provider| provider.id == "lab-server"), "a hand-made server is listed without the catalogue");
        let problem = disconnect_in(&paths, "lab-server").unwrap_err();
        assert!(problem.contains("nothing was removed"), "{problem}");
        assert_eq!(std::fs::read_to_string(paths.config_file()).unwrap(), config);
    }

    #[test]
    fn without_the_catalogue_a_server_without_a_name_is_still_listed_and_offered() {
        let (_dir, paths) = paths();
        std::fs::remove_file(paths.catalog_file()).unwrap();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        std::fs::write(paths.config_file(), json!({"provider": {
            "lab-server": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "http://127.0.0.1:1234/v1"}, "whitelist": ["qwen3"], "models": {"qwen3": {"name": "Qwen 3"}}},
            "openrouter": {"npm": "@ai-sdk/openai-compatible", "name": "My gateway", "options": {"baseURL": "https://gateway.example.internal/v1"}, "whitelist": ["openai/gpt-5"]},
        }}).to_string()).unwrap();
        let overview = overview_in(&paths, false);
        assert!(overview.catalog_problem.is_some(), "the test runs without a provider list");
        assert_eq!(overview.connected.iter().map(|provider| provider.id.as_str()).collect::<Vec<_>>(), vec!["lab-server"], "a known provider's keyless gateway stays unlisted, named or not");
        assert_eq!(overview.models.iter().map(|model| (model.id.as_str(), model.name.as_str())).collect::<Vec<_>>(), vec![("lab-server/qwen3", "Qwen 3")]);
    }

    #[test]
    fn without_the_catalogue_disconnect_of_a_listed_server_with_a_key_changes_nothing() {
        let (_dir, paths) = paths();
        std::fs::remove_file(paths.catalog_file()).unwrap();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        let config = json!({"provider": {"lab-server": {"npm": "@ai-sdk/openai-compatible", "name": "Lab server",
            "options": {"baseURL": "https://lab.example.internal/v1", "apiKey": "lab-0123456789abcdef"}, "whitelist": ["qwen3"], "models": {"qwen3": {}}}}}).to_string();
        std::fs::write(paths.config_file(), &config).unwrap();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let auth = json!({"lab-server": {"type": "api", "key": "lab-fedcba9876543210"}}).to_string();
        std::fs::write(paths.auth_file(), &auth).unwrap();
        assert!(overview_in(&paths, false).connected.iter().any(|provider| provider.id == "lab-server"));
        let problem = disconnect_in(&paths, "lab-server").unwrap_err();
        assert!(problem.contains("nothing was removed"), "{problem}");
        assert_eq!((std::fs::read_to_string(paths.config_file()).unwrap(), std::fs::read_to_string(paths.auth_file()).unwrap()), (config, auth), "no success while it stays listed");
    }

    #[test]
    fn a_stuck_disconnect_says_how_to_restore_what_the_form_cannot() {
        let config = Path::new("/home/someone/.config/opencode/opencode.json");
        let gateway = json!({"options": {"baseURL": "https://gateway.example.internal/v1", "apiKey": "gw-0123456789abcdef"}});
        assert_eq!(restore_hint("openrouter", &gateway, false, config), "connect openrouter again to restore it.");
        assert_eq!(restore_hint(OLLAMA, &json!({"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": OLLAMA_URL}}), true, config), "connect ollama again to restore it.");
        let server = json!({"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "https://lab:secret-0123456789@lab.example.internal/v1", "apiKey": "lab-0123456789abcdef"}});
        let hint = restore_hint("lab-server", &server, true, config);
        assert!(hint.contains("\"@ai-sdk/openai-compatible\"") && hint.contains("\"https://lab.example.internal/v1\""), "{hint}");
        assert!(!hint.contains("secret") && !hint.contains("lab-0123456789abcdef") && !hint.contains("connect lab-server again"), "{hint}");
    }

    #[test]
    fn the_built_in_provider_ids_are_one_per_line() {
        assert!(known_provider("openrouter") && known_provider("anthropic") && !known_provider("lab-server") && !known_provider(""));
        assert!(KNOWN_PROVIDERS.lines().all(|id| !id.is_empty() && id.trim() == id));
    }

    #[cfg(unix)]
    #[test]
    fn disconnect_puts_the_config_back_when_the_key_file_cannot_be_written() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        let config = json!({"provider": {"openrouter": {"options": {"apiKey": "sk-or-0123456789abcdef"}}}}).to_string();
        std::fs::write(paths.config_file(), &config).unwrap();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let auth = json!({"openrouter": {"type": "api", "key": "sk-or-fedcba9876543210"}}).to_string();
        std::fs::write(paths.auth_file(), &auth).unwrap();
        std::fs::set_permissions(&paths.data_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = disconnect_in(&paths, "openrouter");
        std::fs::set_permissions(&paths.data_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.unwrap_err().contains("Nothing was disconnected"));
        assert_eq!(std::fs::read_to_string(paths.config_file()).unwrap(), config, "the config key is back");
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), auth);
    }

    #[test]
    fn disconnect_refuses_while_the_config_cannot_be_read() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        // Broken JSON that still holds a key, which would reconnect it once repaired.
        let config = "{\"provider\": {\"openrouter\": {\"options\": {\"apiKey\": \"sk-or-0123456789abcdef\"}}}";
        std::fs::write(paths.config_file(), config).unwrap();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let auth = json!({"openrouter": {"type": "api", "key": "sk-or-fedcba9876543210"}}).to_string();
        std::fs::write(paths.auth_file(), &auth).unwrap();
        assert!(disconnect_in(&paths, "openrouter").unwrap_err().contains("can’t be read"));
        assert_eq!((std::fs::read_to_string(paths.config_file()).unwrap(), std::fs::read_to_string(paths.auth_file()).unwrap()), (config.to_owned(), auth), "nothing changed");
    }

    #[test]
    fn a_list_downloaded_this_run_serves_the_overviews_actions_return() {
        let (_dir, paths) = paths();
        std::fs::remove_file(paths.catalog_file()).unwrap();
        let fetched = std::sync::Mutex::new(None);
        let downloads = std::cell::Cell::new(0);
        let download = || { downloads.set(downloads.get() + 1); Ok(json!({"openrouter": {"name": "OpenRouter"}}).as_object().cloned().unwrap()) };
        assert!(catalog_from(&paths, false, &fetched, download).unwrap_err().contains("has not downloaded"));
        assert!(catalog_from(&paths, true, &fetched, download).unwrap().contains_key("openrouter"));
        assert!(catalog_from(&paths, false, &fetched, download).unwrap().contains_key("openrouter"), "no fetch, but the copy from this run");
        assert_eq!(downloads.get(), 1);
        // OpenCode's own copy, once it has one, comes first.
        std::fs::write(paths.catalog_file(), json!({"anthropic": {"name": "Anthropic"}}).to_string()).unwrap();
        assert!(catalog_from(&paths, false, &fetched, download).unwrap().contains_key("anthropic"));
    }

    #[test]
    fn disconnect_keeps_a_catalogue_providers_gateway_even_with_its_own_sdk() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        let entry = json!({"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "https://gateway.example.internal/v1", "apiKey": "gw-0123456789abcdef"}, "whitelist": ["openai/gpt-5"]});
        std::fs::write(paths.config_file(), json!({"provider": {"openrouter": entry}}).to_string()).unwrap();
        assert_eq!(overview_in(&paths, false).connected.len(), 1);
        let after = disconnect_in(&paths, "openrouter").unwrap();
        assert!(after.connected.is_empty(), "with its key gone it is not listed");
        let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
        let kept = &config["provider"]["openrouter"];
        assert_eq!((kept["npm"].clone(), kept["options"]["baseURL"].clone()), (entry["npm"].clone(), entry["options"]["baseURL"].clone()));
        assert!(kept["options"].get("apiKey").is_none());
    }

    #[test]
    fn disconnect_removes_a_server_set_up_by_hand() {
        let (_dir, paths) = paths();
        std::fs::create_dir_all(&paths.config_dir).unwrap();
        // A non-Ollama server with no key, beside a gateway kept in the config and a key in auth.json.
        let gateway = json!({"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "https://gateway.example.internal/v1", "apiKey": "gw-0123456789abcdef"}, "whitelist": ["openai/gpt-5"]});
        std::fs::write(paths.config_file(), json!({"provider": {"lmstudio": {
            "npm": "@ai-sdk/openai-compatible", "name": "LM Studio", "options": {"baseURL": "http://127.0.0.1:1234/v1"}, "whitelist": ["qwen3"], "models": {"qwen3": {}}},
            "openrouter": gateway}}).to_string()).unwrap();
        std::fs::create_dir_all(&paths.data_dir).unwrap();
        let auth = json!({"anthropic": {"type": "oauth", "refresh": "r", "access": "a", "expires": 1}}).to_string();
        std::fs::write(paths.auth_file(), &auth).unwrap();
        let before = overview_in(&paths, false);
        let server = before.connected.iter().find(|provider| provider.id == "lmstudio").unwrap();
        assert_eq!((before.connected.len(), server.auth.as_str(), server.masked_key.as_deref()), (3, "config", None));
        let after = disconnect_in(&paths, "lmstudio").unwrap();
        let mut left: Vec<&str> = after.connected.iter().map(|provider| provider.id.as_str()).collect();
        left.sort_unstable();
        assert_eq!(left, ["anthropic", "openrouter"], "Disconnect does what it says, and only to this one");
        assert!(!after.models.iter().any(|model| model.provider == "lmstudio"), "its models leave the picker");
        let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.config_file()).unwrap()).unwrap();
        let entry = &config["provider"]["lmstudio"];
        assert!(entry.get("npm").is_none() && entry["options"].get("baseURL").is_none());
        assert_eq!((entry["whitelist"].clone(), entry["models"].clone()), (json!(["qwen3"]), json!({"qwen3": {}})), "its models stay for a reconnect");
        assert_eq!(config["provider"]["openrouter"], gateway, "an unrelated provider is untouched");
        assert_eq!(std::fs::read_to_string(paths.auth_file()).unwrap(), auth, "auth.json is not rewritten for a config-only server");
    }

    #[test]
    fn bad_input_is_refused_before_anything_is_written() {
        let (_dir, paths) = paths();
        assert!(connect_in(&paths, "weird", "  ", None).unwrap_err().contains("Paste a Weird API key"));
        assert!(connect_in(&paths, "nobody", "key-0123456789abc", None).unwrap_err().contains("doesn’t know a provider"));
        assert!(connect_in(&paths, "weird", "key-0123456789abc", Some("ftp://x")).unwrap_err().contains("http"));
        assert!(add_model_in(&paths, "weird", "two words").is_err());
        assert!(!paths.auth_file().exists() && !paths.config_file().exists());
    }

    #[test]
    fn each_sdk_is_asked_at_its_own_address() {
        assert_eq!(probe_for("anthropic", Some("@ai-sdk/anthropic"), None, None), Some(("https://api.anthropic.com/v1/models".into(), "anthropic")));
        assert_eq!(probe_for("openrouter", Some("@openrouter/ai-sdk-provider"), Some("https://openrouter.ai/api/v1"), None), Some(("https://openrouter.ai/api/v1/key".into(), "bearer")));
        assert_eq!(probe_for("groq", Some("@ai-sdk/groq"), None, Some("https://proxy.example/v1/")), Some(("https://proxy.example/v1/models".into(), "bearer")));
        assert_eq!(probe_for("deepseek", Some("@ai-sdk/openai-compatible"), Some("https://api.deepseek.com"), None), Some(("https://api.deepseek.com/models".into(), "bearer")));
        assert_eq!(probe_for("custom", Some("@ai-sdk/openai-compatible"), None, None), None);
        assert_eq!(probe_for("weird", Some("weird-sdk"), None, None), None);
    }

    #[test]
    fn the_newest_written_log_is_the_one_opened() {
        let (_dir, paths) = paths();
        assert_eq!(latest_log(&paths), None);
        std::fs::create_dir_all(paths.log_dir()).unwrap();
        std::fs::write(paths.log_dir().join("opencode.log"), "").unwrap();
        assert_eq!(latest_log(&paths), Some(paths.log_dir()), "an empty log is passed over for the folder");
        std::fs::write(paths.log_dir().join("2026-11-06T231609.log"), "INFO started").unwrap();
        assert_eq!(latest_log(&paths), Some(paths.log_dir().join("2026-11-06T231609.log")));
    }

    #[test]
    fn valid_url_rejects_non_loopback_http_and_allows_loopback_or_https() {
        assert!(valid_url("https://api.anthropic.com/v1").is_ok());
        assert!(valid_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(valid_url("http://localhost:8080/v1").is_ok());
        assert!(valid_url("http://[::1]:11434/v1").is_ok());
        assert!(valid_url("http://evil.example.com/v1").is_err());
        assert!(valid_url("http://10.0.0.5:8080/v1").is_err());
        assert!(valid_url("ftp://example.com").is_err());
    }

    #[test]
    fn check_key_does_not_follow_redirects_with_api_key_headers() {
        use std::io::{Read, Write};
        let (sink_url, sink_listener) = untouched();
        let redirect_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let redirect_addr = redirect_listener.local_addr().unwrap();
        let target = format!("{sink_url}/steal");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = redirect_listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let resp = format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(resp.as_bytes());
        });
        let provider = CatalogProvider {
            id: "anthropic".into(),
            name: "Anthropic".into(),
            env: vec![],
            api: None,
            doc: None,
            model_count: 0,
            base_url: None,
            local: false,
        };
        let err = check_key(
            &provider,
            Some("@ai-sdk/anthropic"),
            "sk-ant-secret-key-0123456789",
            Some(&format!("http://{redirect_addr}/v1")),
        )
        .unwrap_err();
        server.join().unwrap();
        assert!(err.contains("redirect"), "expected redirect refusal, got: {err}");
        never_asked(&sink_listener, "redirect target");
    }
}
