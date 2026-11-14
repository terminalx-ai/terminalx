//! View-scoped, nonrecursive watches; replacing a file or creating a missing
//! .terminalx directory must not detach the Settings view from future changes.
use std::{collections::BTreeSet, path::PathBuf, sync::mpsc, time::Duration};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use tauri::Manager;

enum Signal { Event(notify::Result<Event>), Stop }
struct ConfigurationWatch { stop: mpsc::Sender<Signal> }
impl tauri::Resource for ConfigurationWatch {}
impl Drop for ConfigurationWatch {
    fn drop(&mut self) { let _ = self.stop.send(Signal::Stop); }
}

fn directories(paths: &[PathBuf]) -> BTreeSet<PathBuf> {
    paths.iter().filter_map(|path| path.ancestors().skip(1).find(|parent| parent.is_dir()).map(PathBuf::from)).collect()
}
fn affects(paths: &[PathBuf], event: &Event) -> bool {
    !matches!(event.kind, EventKind::Access(_)) && (event.paths.is_empty()
        || event.paths.iter().any(|changed| paths.iter().any(|path| path.starts_with(changed))))
}

fn start(paths: Vec<PathBuf>, changed: impl Fn() -> bool + Send + 'static) -> anyhow::Result<ConfigurationWatch> {
    let (send, receive) = mpsc::channel();
    let events = send.clone();
    let mut watcher = notify::recommended_watcher(move |event| { let _ = events.send(Signal::Event(event)); })?;
    let mut watched = directories(&paths);
    for directory in &watched { watcher.watch(directory, RecursiveMode::NonRecursive)?; }
    std::thread::Builder::new().name("configuration-watch".into()).spawn(move || {
        loop {
            let dirty = match receive.recv_timeout(Duration::from_secs(1)) {
                Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(Signal::Event(Ok(event))) => affects(&paths, &event),
                Ok(Signal::Event(Err(_))) => true,
                Err(mpsc::RecvTimeoutError::Timeout) => false,
            };
            let next = directories(&paths);
            let relocated = next != watched;
            // Reattach even when a replacement directory has the same pathname:
            // some backends keep watching the old inode after an atomic rename.
            if dirty {
                for old in &watched { let _ = watcher.unwatch(old); }
                watched.clear();
            }
            for old in watched.difference(&next) { let _ = watcher.unwatch(old); }
            let mut attached = next.intersection(&watched).cloned().collect::<BTreeSet<_>>();
            for new in next.difference(&watched) {
                if watcher.watch(new, RecursiveMode::NonRecursive).is_ok() { attached.insert(new.clone()); }
            }
            watched = attached;
            if (dirty || relocated) && !changed() { break; }
        }
    })?;
    Ok(ConfigurationWatch { stop: send })
}

#[tauri::command]
pub async fn configuration_watch(webview: tauri::Webview, project_path: Option<String>, on_change: tauri::ipc::Channel<()>) -> Result<tauri::ResourceId, String> {
    let resource = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let home = crate::store::root()?.canonicalize()?;
        let mut paths = vec![home.join("settings.json"), home.join("repository-trust.json"), home.join("environment.json")];
        if let Some(path) = crate::store::managed_configuration::path() { paths.push(path.into()); }
        if let Some(project) = project_path {
            let root = crate::store::configuration::repository(std::path::Path::new(&project))?.root;
            paths.extend([root.join(".terminalx/settings.json"), root.join(".terminalx/settings.local.json"), root.join(".terminalx/.gitignore"), root.join(".git/index")]);
        }
        start(paths, move || on_change.send(()).is_ok())
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(webview.resources_table().add(resource))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watch_survives_missing_directory_and_atomic_replacements() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap().join(".terminalx");
        let file = directory.join("settings.json");
        let (send, receive) = mpsc::channel();
        let watch = start(vec![file.clone()], move || send.send(()).is_ok()).unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(&file, b"{}").unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        // Allow queued creation events to drain; each replacement must still be observed.
        while receive.recv_timeout(Duration::from_millis(300)).is_ok() {}
        let replacement = directory.join("new.json");
        std::fs::write(&replacement, b"{\"branchPrefix\":\"team/\"}").unwrap();
        std::fs::rename(replacement, &file).unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        while receive.recv_timeout(Duration::from_millis(300)).is_ok() {}
        std::fs::remove_dir_all(&directory).unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(&file, b"{}").unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        while receive.recv_timeout(Duration::from_millis(300)).is_ok() {}
        std::fs::write(&file, b"{ } ").unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        drop(watch);
    }
    #[test]
    fn unrelated_files_and_read_events_do_not_reload_settings() {
        let files = vec![PathBuf::from("/repo/.terminalx/settings.json")];
        assert!(affects(&files, &Event::new(EventKind::Any).add_path(PathBuf::from("/repo/.terminalx"))));
        assert!(!affects(&files, &Event::new(EventKind::Any).add_path(PathBuf::from("/repo/README.md"))));
        assert!(!affects(&files, &Event::new(EventKind::Access(notify::event::AccessKind::Any)).add_path(files[0].clone())));
    }
}
