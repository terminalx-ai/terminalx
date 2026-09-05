//! Browser pages: the app's own ids for agent-browser tabs, scoped to the
//! workspace that opened them, with one active page per workspace. The
//! store is the source of truth for the sidebar and for unqualified CLI
//! commands; agent-browser's `tab list` is reconciled into it whenever the
//! app looks.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::{BrowserError, BrowserResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPage {
    pub id: String,
    pub profile_id: String,
    /// agent-browser's stable tab id inside the profile's session (`t1`…).
    pub tab_id: String,
    pub url: String,
    pub title: String,
    /// The workspace (session cwd) the page belongs to; `None` for a tab the
    /// reader opened in the browser window that no workspace has claimed.
    pub workspace_path: Option<String>,
    pub created: String,
}

/// A page as the CLI and UI see it: the store entry plus whether it is its
/// workspace's active page.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    #[serde(flatten)]
    pub page: BrowserPage,
    pub browser_page_id: String,
    pub active: bool,
    pub index: usize,
}

/// One entry of agent-browser's `tab list`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabListing {
    pub tab_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PagesSnapshot {
    pub pages: Vec<BrowserPage>,
    /// workspace path → active page id
    pub active: BTreeMap<String, String>,
}

pub struct PageStore {
    file: PathBuf,
    state: Mutex<PagesSnapshot>,
}

pub fn new_page_id() -> String {
    format!("bp-{}", &uuid::Uuid::new_v4().simple().to_string()[..10])
}

impl PageStore {
    pub fn open(file: PathBuf) -> anyhow::Result<Self> {
        let state: PagesSnapshot = crate::store::read_json(&file)?.unwrap_or_default();
        Ok(Self { file, state: Mutex::new(state) })
    }

    /// A fresh app run has no browser yet: every remembered page is gone.
    pub fn reset(&self) -> BrowserResult<()> {
        self.mutate(|s| {
            *s = PagesSnapshot::default();
            Ok(())
        })
    }

    pub fn snapshot(&self) -> PagesSnapshot {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut PagesSnapshot) -> BrowserResult<R>) -> BrowserResult<R> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let out = f(&mut state)?;
        crate::store::write_json(&self.file, &*state).map_err(|e| BrowserError::new("browser_error", format!("{e:#}")))?;
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Option<BrowserPage> {
        self.snapshot().pages.into_iter().find(|p| p.id == id)
    }

    /// Exact id, then an unambiguous prefix.
    pub fn resolve(&self, selector: &str) -> BrowserResult<BrowserPage> {
        let pages = self.snapshot().pages;
        if let Some(page) = pages.iter().find(|p| p.id == selector) {
            return Ok(page.clone());
        }
        let matches: Vec<&BrowserPage> = pages.iter().filter(|p| p.id.starts_with(selector)).collect();
        match matches.len() {
            1 => Ok(matches[0].clone()),
            0 => Err(BrowserError::new("browser_tab_not_found", format!("No browser page matches {selector}."))),
            _ => Err(BrowserError::new("ambiguous_selector", format!("More than one browser page matches {selector}."))),
        }
    }

    pub fn infos(&self, workspace: Option<&str>) -> Vec<PageInfo> {
        let snapshot = self.snapshot();
        snapshot
            .pages
            .iter()
            .filter(|p| workspace.map(|w| p.workspace_path.as_deref() == Some(w)).unwrap_or(true))
            .enumerate()
            .map(|(index, p)| PageInfo {
                browser_page_id: p.id.clone(),
                active: p.workspace_path.as_ref().and_then(|w| snapshot.active.get(w)).map(|a| a == &p.id).unwrap_or(false),
                index,
                page: p.clone(),
            })
            .collect()
    }

    pub fn info(&self, id: &str) -> Option<PageInfo> {
        self.infos(None).into_iter().find(|p| p.page.id == id)
    }

    pub fn active_for(&self, workspace: &str) -> Option<BrowserPage> {
        let snapshot = self.snapshot();
        let id = snapshot.active.get(workspace)?;
        snapshot.pages.into_iter().find(|p| &p.id == id)
    }

    pub fn in_profile(&self, profile_id: &str) -> Vec<BrowserPage> {
        self.snapshot().pages.into_iter().filter(|p| p.profile_id == profile_id).collect()
    }

    /// Add a page and make it its workspace's active one.
    pub fn insert(&self, page: BrowserPage) -> BrowserResult<()> {
        self.mutate(|s| {
            if let Some(w) = &page.workspace_path {
                s.active.insert(w.clone(), page.id.clone());
            }
            s.pages.retain(|p| p.id != page.id);
            s.pages.push(page);
            Ok(())
        })
    }

    pub fn set_active(&self, page_id: &str) -> BrowserResult<BrowserPage> {
        self.mutate(|s| {
            let page = s.pages.iter().find(|p| p.id == page_id).cloned().ok_or_else(|| BrowserError::new("browser_tab_not_found", format!("No browser page {page_id}.")))?;
            if let Some(w) = &page.workspace_path {
                s.active.insert(w.clone(), page.id.clone());
            }
            Ok(page)
        })
    }

    pub fn update_location(&self, page_id: &str, url: Option<&str>, title: Option<&str>) -> BrowserResult<bool> {
        self.mutate(|s| {
            let Some(page) = s.pages.iter_mut().find(|p| p.id == page_id) else { return Ok(false) };
            let mut changed = false;
            if let Some(url) = url {
                if page.url != url {
                    page.url = url.to_string();
                    changed = true;
                }
            }
            if let Some(title) = title {
                if page.title != title {
                    page.title = title.to_string();
                    changed = true;
                }
            }
            Ok(changed)
        })
    }

    /// Remove a page; the workspace's active page moves to its neighbour.
    pub fn remove(&self, page_id: &str) -> BrowserResult<Option<BrowserPage>> {
        self.mutate(|s| Ok(remove_in(s, page_id)))
    }

    /// Bring the store in line with what agent-browser reports for one
    /// profile. Tabs the store never saw (opened by the reader in the
    /// window, popups, the launch tab) are adopted into `fallback_workspace`;
    /// pages whose tab is gone are dropped; urls and titles are refreshed.
    /// Returns whether anything changed.
    pub fn reconcile(&self, profile_id: &str, tabs: &[TabListing], fallback_workspace: Option<&str>) -> BrowserResult<bool> {
        self.mutate(|s| {
            let mut changed = false;
            let gone: Vec<String> = s
                .pages
                .iter()
                .filter(|p| p.profile_id == profile_id && !tabs.iter().any(|t| t.tab_id == p.tab_id))
                .map(|p| p.id.clone())
                .collect();
            for id in gone {
                remove_in(s, &id);
                changed = true;
            }
            for tab in tabs {
                match s.pages.iter_mut().find(|p| p.profile_id == profile_id && p.tab_id == tab.tab_id) {
                    Some(page) => {
                        if page.url != tab.url || page.title != tab.title {
                            page.url = tab.url.clone();
                            page.title = tab.title.clone();
                            changed = true;
                        }
                    }
                    None => {
                        let page = BrowserPage {
                            id: new_page_id(),
                            profile_id: profile_id.to_string(),
                            tab_id: tab.tab_id.clone(),
                            url: tab.url.clone(),
                            title: tab.title.clone(),
                            workspace_path: fallback_workspace.map(String::from),
                            created: crate::store::index::now(),
                        };
                        if let Some(w) = &page.workspace_path {
                            s.active.entry(w.clone()).or_insert_with(|| page.id.clone());
                        }
                        s.pages.push(page);
                        changed = true;
                    }
                }
            }
            Ok(changed)
        })
    }

    /// Forget every page of a profile (its browser was closed).
    pub fn remove_profile(&self, profile_id: &str) -> BrowserResult<Vec<BrowserPage>> {
        self.mutate(|s| {
            let ids: Vec<String> = s.pages.iter().filter(|p| p.profile_id == profile_id).map(|p| p.id.clone()).collect();
            Ok(ids.iter().filter_map(|id| remove_in(s, id)).collect())
        })
    }

    /// Forget every page of a workspace that was deleted.
    pub fn remove_workspace(&self, workspace: &str) -> BrowserResult<Vec<BrowserPage>> {
        self.mutate(|s| {
            let ids: Vec<String> = s.pages.iter().filter(|p| p.workspace_path.as_deref() == Some(workspace)).map(|p| p.id.clone()).collect();
            let removed = ids.iter().filter_map(|id| remove_in(s, id)).collect();
            s.active.remove(workspace);
            Ok(removed)
        })
    }
}

fn remove_in(s: &mut PagesSnapshot, page_id: &str) -> Option<BrowserPage> {
    let index = s.pages.iter().position(|p| p.id == page_id)?;
    let removed = s.pages.remove(index);
    if let Some(w) = &removed.workspace_path {
        if s.active.get(w) == Some(&removed.id) {
            let siblings: Vec<&BrowserPage> = s.pages.iter().filter(|p| p.workspace_path.as_deref() == Some(w.as_str())).collect();
            match siblings.get(index.min(siblings.len().saturating_sub(1))) {
                Some(next) if !siblings.is_empty() => {
                    let next = next.id.clone();
                    s.active.insert(w.clone(), next);
                }
                _ => {
                    s.active.remove(w);
                }
            }
        }
    }
    Some(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, tab: &str, ws: &str) -> BrowserPage {
        BrowserPage { id: id.into(), profile_id: "default".into(), tab_id: tab.into(), url: format!("https://{id}"), title: id.into(), workspace_path: Some(ws.into()), created: "now".into() }
    }

    fn store() -> (tempfile::TempDir, PageStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = PageStore::open(tmp.path().join("pages.json")).unwrap();
        (tmp, store)
    }

    #[test]
    fn insert_activates_and_removal_moves_the_active_page_to_a_neighbour() {
        let (_tmp, store) = store();
        store.insert(page("bp-a", "t1", "/ws")).unwrap();
        store.insert(page("bp-b", "t2", "/ws")).unwrap();
        store.insert(page("bp-c", "t3", "/ws")).unwrap();
        store.insert(page("bp-z", "t4", "/other")).unwrap();
        assert_eq!(store.active_for("/ws").unwrap().id, "bp-c");
        store.set_active("bp-b").unwrap();
        store.remove("bp-b").unwrap();
        assert_eq!(store.active_for("/ws").unwrap().id, "bp-c");
        store.remove("bp-c").unwrap();
        assert_eq!(store.active_for("/ws").unwrap().id, "bp-a");
        store.remove("bp-a").unwrap();
        assert!(store.active_for("/ws").is_none());
        assert_eq!(store.active_for("/other").unwrap().id, "bp-z");
        let infos = store.infos(Some("/other"));
        assert_eq!(infos.len(), 1);
        assert!(infos[0].active);
        assert_eq!(infos[0].browser_page_id, "bp-z");
    }

    #[test]
    fn resolves_exact_ids_and_unambiguous_prefixes() {
        let (_tmp, store) = store();
        store.insert(page("bp-abc123", "t1", "/ws")).unwrap();
        store.insert(page("bp-abd456", "t2", "/ws")).unwrap();
        assert_eq!(store.resolve("bp-abc123").unwrap().id, "bp-abc123");
        assert_eq!(store.resolve("bp-abd").unwrap().id, "bp-abd456");
        assert_eq!(store.resolve("bp-ab").unwrap_err().code, "ambiguous_selector");
        assert_eq!(store.resolve("nope").unwrap_err().code, "browser_tab_not_found");
    }

    #[test]
    fn reconcile_adopts_unknown_tabs_drops_closed_ones_and_refreshes_titles() {
        let (_tmp, store) = store();
        store.insert(page("bp-a", "t1", "/ws")).unwrap();
        store.insert(page("bp-b", "t2", "/ws")).unwrap();
        let listing = vec![
            TabListing { tab_id: "t2".into(), url: "https://bp-b/next".into(), title: "Next".into(), active: true },
            TabListing { tab_id: "t3".into(), url: "https://popup".into(), title: "Popup".into(), active: false },
        ];
        assert!(store.reconcile("default", &listing, Some("/ws")).unwrap());
        let pages = store.snapshot().pages;
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.tab_id != "t1"));
        let b = pages.iter().find(|p| p.tab_id == "t2").unwrap();
        assert_eq!((b.url.as_str(), b.title.as_str()), ("https://bp-b/next", "Next"));
        let adopted = pages.iter().find(|p| p.tab_id == "t3").unwrap();
        assert_eq!(adopted.workspace_path.as_deref(), Some("/ws"));
        assert!(!store.reconcile("default", &listing, Some("/ws")).unwrap());
    }

    #[test]
    fn a_new_run_starts_with_no_pages_but_the_file_survives_reopen() {
        let (tmp, store) = store();
        store.insert(page("bp-a", "t1", "/ws")).unwrap();
        drop(store);
        let reopened = PageStore::open(tmp.path().join("pages.json")).unwrap();
        assert_eq!(reopened.snapshot().pages.len(), 1);
        reopened.reset().unwrap();
        assert!(reopened.snapshot().pages.is_empty());
    }
}
