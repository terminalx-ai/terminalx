//! `terminalx-serve projects`: list the projects a paired computer sees on
//! this server, or add a folder as one (PRO-353). A fresh server has none, and
//! a session runs in a project, so this is how its first session gets one:
//! clone a repository, then `terminalx-serve projects add <folder>`.
//!
//! The runtime writes the project store (`projects.add` on its control
//! socket), so nothing it writes at the same time is lost, and connected
//! computers hear of the new project at once.

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use super::control_client::Runtime;

const USAGE: &str = "\
Usage: terminalx-serve projects [add <folder>] [--data-dir <dir>]

  (none)          List the projects paired computers see on this server
  add <folder>    Add a folder as a project, usually a Git clone";

/// Run `terminalx-serve projects` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match projects(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve projects: {error:#}");
            1
        }
    }
}

fn projects(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
    match rest.as_slice() {
        [] => {
            let runtime = Runtime::connect_or_start(&super::resolve_data_dir(flag.as_deref())?)?;
            let listed = runtime.call("projects.list", json!({}))?;
            print!("{}", describe(&listed));
            Ok(0)
        }
        ["add", folder] => {
            // The runtime runs elsewhere: it is given the full path.
            let path = crate::paths::canonicalize(folder).with_context(|| format!("{folder} is not a folder here"))?;
            if !path.is_dir() {
                anyhow::bail!("{} is not a folder", path.display());
            }
            let runtime = Runtime::connect_or_start(&super::resolve_data_dir(flag.as_deref())?)?;
            let added = runtime.call("projects.add", json!({ "path": path }))?;
            let name = added["project"]["name"].as_str().unwrap_or_default();
            println!("Added {name} ({}). Paired computers can start sessions in it now.", display(&added["project"]["path"], &path));
            Ok(0)
        }
        ["-h" | "--help" | "help"] => {
            println!("{USAGE}");
            Ok(0)
        }
        _ => {
            eprintln!("{USAGE}");
            Ok(2)
        }
    }
}

fn display(value: &Value, fallback: &Path) -> String {
    value.as_str().map(str::to_string).unwrap_or_else(|| fallback.display().to_string())
}

/// The list as `projects` prints it.
fn describe(listed: &Value) -> String {
    let projects: Vec<&Value> = listed["projects"].as_array().map(|projects| projects.iter().filter(|project| project["archived"] != true).collect()).unwrap_or_default();
    if projects.is_empty() {
        return "No projects yet. Add one with `terminalx-serve projects add <folder>`.\n".into();
    }
    let width = projects.iter().filter_map(|project| project["name"].as_str()).map(|name| name.chars().count()).max().unwrap_or(0);
    projects
        .iter()
        .map(|project| format!("{:width$}  {}\n", project["name"].as_str().unwrap_or_default(), project["path"].as_str().unwrap_or_default()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_names_each_project_and_skips_archived_ones() {
        let listed = json!({ "projects": [
            { "name": "api", "path": "/home/me/api", "archived": false },
            { "name": "old", "path": "/home/me/old", "archived": true },
            { "name": "website", "path": "/home/me/website" },
        ] });
        assert_eq!(describe(&listed), "api      /home/me/api\nwebsite  /home/me/website\n");
        assert!(describe(&json!({ "projects": [] })).contains("projects add"));
    }

    #[test]
    fn usage_errors_exit_two() {
        assert_eq!(run(&["remove".into()]), 2);
        assert_eq!(run(&["add".into()]), 2);
    }
}
