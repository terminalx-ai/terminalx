//! User-initiated installation of the CLI links and first-party skill stub.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliToolStatus {
    pub installed: bool,
    pub directory: String,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetStatus {
    pub path: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallStatus {
    pub installed: bool,
    pub targets: Vec<SkillTargetStatus>,
}

fn user_home() -> Result<PathBuf> {
    dirs::home_dir().context("no home directory")
}

fn cli_dir(home: &Path) -> PathBuf {
    home.join(".local/bin")
}

fn cli_status_at(home: &Path, target: &Path) -> CliToolStatus {
    let directory = cli_dir(home);
    let commands: Vec<String> = ["terminalx", "tnx"]
        .iter()
        .map(|name| directory.join(name).to_string_lossy().into_owned())
        .collect();
    let installed = commands.iter().all(|command| {
        std::fs::read_link(command)
            .map(|link| link == target)
            .unwrap_or(false)
    });
    CliToolStatus {
        installed,
        directory: directory.to_string_lossy().into_owned(),
        commands,
    }
}

#[tauri::command]
pub fn cli_tool_status() -> Result<CliToolStatus, String> {
    let home = user_home().map_err(|error| format!("{error:#}"))?;
    let target = std::env::current_exe().map_err(|error| format!("locate this app: {error}"))?;
    Ok(cli_status_at(&home, &target))
}

#[tauri::command]
pub fn install_cli_tool() -> Result<CliToolStatus, String> {
    let home = user_home().map_err(|error| format!("{error:#}"))?;
    let target = std::env::current_exe().map_err(|error| format!("locate this app: {error}"))?;
    install_cli_links(&home, &target).map_err(|error| format!("{error:#}"))?;
    Ok(cli_status_at(&home, &target))
}

#[cfg(unix)]
fn install_cli_links(home: &Path, target: &Path) -> Result<()> {
    use std::os::unix::fs::symlink;

    let directory = cli_dir(home);
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create {}", directory.display()))?;
    for name in ["terminalx", "tnx"] {
        let link = directory.join(name);
        if let Ok(metadata) = std::fs::symlink_metadata(&link) {
            if !metadata.file_type().is_symlink() {
                bail!("{} already exists and is not a symlink", link.display());
            }
        }
    }
    for name in ["terminalx", "tnx"] {
        let link = directory.join(name);
        match std::fs::symlink_metadata(&link) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                if std::fs::read_link(&link).ok().as_deref() == Some(target) {
                    continue;
                }
                std::fs::remove_file(&link)
                    .with_context(|| format!("replace {}", link.display()))?;
            }
            Ok(_) => unreachable!("ordinary files were refused before installation"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("inspect {}", link.display())),
        }
        symlink(target, &link).with_context(|| format!("link {}", link.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn install_cli_links(_home: &Path, _target: &Path) -> Result<()> {
    bail!("the command line tool currently requires Unix")
}

fn skill_targets(home: &Path) -> [PathBuf; 2] {
    [
        home.join(".claude/skills/terminalx-cli/SKILL.md"),
        home.join(".agents/skills/terminalx-cli/SKILL.md"),
    ]
}

fn skill_status_at(home: &Path) -> SkillInstallStatus {
    let targets = skill_targets(home)
        .into_iter()
        .map(|path| {
            let installed = std::fs::read_to_string(&path)
                .map(|contents| contents == crate::cli::SKILL_STUB)
                .unwrap_or(false);
            SkillTargetStatus {
                path: path.to_string_lossy().into_owned(),
                installed,
            }
        })
        .collect::<Vec<_>>();
    SkillInstallStatus {
        installed: targets.iter().all(|target| target.installed),
        targets,
    }
}

#[tauri::command]
pub fn cli_skill_status() -> Result<SkillInstallStatus, String> {
    let home = user_home().map_err(|error| format!("{error:#}"))?;
    Ok(skill_status_at(&home))
}

#[tauri::command]
pub fn install_cli_skill() -> Result<SkillInstallStatus, String> {
    let home = user_home().map_err(|error| format!("{error:#}"))?;
    install_skill_at(&home, crate::cli::SKILL_STUB).map_err(|error| format!("{error:#}"))?;
    Ok(skill_status_at(&home))
}

fn install_skill_at(home: &Path, stub: &str) -> Result<()> {
    for path in skill_targets(home) {
        let parent = path.parent().context("skill target has no parent")?;
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if !metadata.file_type().is_file() {
                bail!("{} exists and is not a regular file", path.display());
            }
        }
        crate::store::write_atomic(&path, stub.as_bytes())
            .with_context(|| format!("install {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn installs_terminalx_and_tnx_without_replacing_a_regular_file() {
        let home = tempfile::tempdir().unwrap();
        let target = home.path().join("Raccoon.app/Contents/MacOS/raccoon");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "binary").unwrap();
        install_cli_links(home.path(), &target).unwrap();
        let status = cli_status_at(home.path(), &target);
        assert!(status.installed);
        assert_eq!(
            status.commands,
            ["terminalx", "tnx"]
                .map(|name| cli_dir(home.path()).join(name).to_string_lossy().into_owned())
        );

        let tnx = cli_dir(home.path()).join("tnx");
        std::fs::remove_file(&tnx).unwrap();
        std::fs::write(&tnx, "mine").unwrap();
        assert!(install_cli_links(home.path(), &target).is_err());
        assert_eq!(std::fs::read_to_string(tnx).unwrap(), "mine");
    }

    #[test]
    fn installs_the_exact_discovery_stub_in_both_skill_homes() {
        let home = tempfile::tempdir().unwrap();
        install_skill_at(home.path(), crate::cli::SKILL_STUB).unwrap();
        let status = skill_status_at(home.path());
        assert!(status.installed);
        assert_eq!(status.targets.len(), 2);
        for path in skill_targets(home.path()) {
            assert!(path.to_string_lossy().contains("/terminalx-cli/SKILL.md"));
            assert_eq!(
                std::fs::read_to_string(path).unwrap(),
                crate::cli::SKILL_STUB
            );
        }
    }
}
