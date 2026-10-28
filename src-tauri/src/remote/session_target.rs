use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use super::protocol::RpcError;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RepositoryTarget {
    pub identity: String,
    pub directory: String,
}

/// Workspace-wide session authority includes its nested checkout projects, never siblings.
pub(crate) fn owns_project(root: &Path, project: &str) -> bool {
    let path = Path::new(project);
    if path == root { return true; }
    path.starts_with(root) && !path.components().any(|part| matches!(part, Component::ParentDir))
        && path.canonicalize().is_ok_and(|canonical| canonical.starts_with(root) && canonical.join(".git").exists())
}

/// The client names an advertised directory, not an arbitrary CWD. Verify it locally
/// before any worktree, blank repository, settings or session can be written.
pub(crate) fn resolve(root: &Path, target: Option<&RepositoryTarget>) -> Result<PathBuf, RpcError> {
    let Some(target) = target else { return Ok(root.to_path_buf()) };
    let refused = || RpcError::new("repository_checkout_unavailable", "The selected repository checkout is missing or does not match. Finish repository setup before starting a session.");
    let advertised = Path::new(&target.directory);
    if target.directory.is_empty() || advertised.components().any(|part| !matches!(part, Component::Normal(_) | Component::CurDir | Component::RootDir)) {
        return Err(refused());
    }
    let candidate = if advertised.is_absolute() { advertised.to_path_buf() } else { root.join(advertised) };
    let path = candidate.canonicalize().map_err(|_| refused())?;
    if !path.starts_with(root) {
        return Err(RpcError::new("repository_checkout_scope_unsupported", "This checkout is outside the runtime workspace scope. Environment session routing for this layout is not supported."));
    }
    if !path.join(".git").exists() {
        return Err(refused());
    }
    let expected = target.identity.strip_prefix("github.com/").ok_or_else(refused)?;
    let parts: Vec<_> = expected.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty() || *part == "." || *part == ".." || !part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')) {
        return Err(refused());
    }
    let origin = crate::git::remote_url(&path).and_then(|url| crate::issues::github_repo_from_url(&url));
    let top = crate::git::run(&path, &["rev-parse", "--show-toplevel"]).ok().and_then(|top| Path::new(top.trim()).canonicalize().ok());
    let common = crate::git::run(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok().and_then(|dir| Path::new(dir.trim()).canonicalize().ok());
    if !origin.is_some_and(|origin| origin.eq_ignore_ascii_case(expected))
        || top.as_ref() != Some(&path)
        || !common.is_some_and(|dir| dir.starts_with(root))
        || crate::git::head_commit(&path).is_none()
    {
        return Err(refused());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_cannot_escape_through_a_symlink_or_parent_component() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let outside = dir.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let root = root.canonicalize().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        for directory in ["../outside", ""] {
            let target = RepositoryTarget { identity: "github.com/acme/api".into(), directory: directory.into() };
            assert_eq!(resolve(&root, Some(&target)).unwrap_err().code, "repository_checkout_unavailable");
        }
        let target = RepositoryTarget { identity: "github.com/acme/api".into(), directory: outside.to_string_lossy().into_owned() };
        assert_eq!(resolve(&root, Some(&target)).unwrap_err().code, "repository_checkout_scope_unsupported");
        #[cfg(unix)]
        {
            for directory in ["linked".to_string(), root.join("linked").to_string_lossy().into_owned()] {
                let target = RepositoryTarget { identity: "github.com/acme/api".into(), directory };
                assert_eq!(resolve(&root, Some(&target)).unwrap_err().code, "repository_checkout_scope_unsupported");
            }
        }
        assert_eq!(resolve(&root, None).unwrap(), root);
        assert!(!owns_project(&root, outside.to_str().unwrap()));
        assert!(!owns_project(&root, root.join("../outside").to_str().unwrap()));
    }
}
