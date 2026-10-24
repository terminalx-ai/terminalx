//! Keep browser-use's stdio helper in the background before its import-time
//! NSScreen probe registers framework Python as a regular macOS application.
//! Only the managed Codex configuration is changed; the user's installation,
//! other MCP servers, and browser windows keep their normal launch behavior.

use std::ffi::OsStr;
use std::path::Path;

use anyhow::{Context, Result};

const STARTUP: &str = include_str!("browser_use_macos/sitecustomize.py");

#[cfg(all(test, feature = "desktop"))]
#[path = "browser_use_macos/live_tests.rs"]
mod live_tests;

pub(super) fn configure(config: &str, home: &Path, inherited_pythonpath: Option<&OsStr>) -> Result<String> {
    let original = config;
    let mut config: toml::Table = toml::from_str(config)?;
    let Some(servers) = config.get_mut("mcp_servers").and_then(toml::Value::as_table_mut) else {
        return Ok(original.to_string());
    };
    let startup = home.join("browser-use-python");
    for server in servers.iter_mut().filter_map(|(_, value)| value.as_table_mut()) {
        if !is_browser_use_stdio(server) {
            continue;
        }
        std::fs::create_dir_all(&startup).context("create browser-use Python startup directory")?;
        crate::store::write_atomic(&startup.join("sitecustomize.py"), STARTUP.as_bytes())?;

        // Codex forwards extra parent variables only when env_vars names them.
        // Preserve that policy, as well as any explicit server PYTHONPATH.
        let forwarded = server
            .get("env_vars")
            .and_then(toml::Value::as_array)
            .is_some_and(|vars| vars.iter().any(|v| v.as_str() == Some("PYTHONPATH")));
        let env = server
            .entry("env")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .context("browser-use MCP env must be a table")?;
        let previous = env
            .get("PYTHONPATH")
            .and_then(toml::Value::as_str)
            .map(OsStr::new)
            .or_else(|| forwarded.then_some(inherited_pythonpath).flatten());
        let paths = std::iter::once(startup.clone()).chain(previous.into_iter().flat_map(std::env::split_paths).filter(|path| path != &startup));
        let pythonpath = std::env::join_paths(paths).context("build browser-use PYTHONPATH")?;
        env.insert(
            "PYTHONPATH".into(),
            toml::Value::String(pythonpath.to_str().context("browser-use PYTHONPATH is not UTF-8")?.into()),
        );
    }
    Ok(format!(
        "# Written by TerminalX. Edit ~/.codex/config.toml instead.\n\n{}",
        toml::to_string_pretty(&config)?
    ))
}

fn is_browser_use_stdio(server: &toml::Table) -> bool {
    let Some(command) = server.get("command").and_then(toml::Value::as_str) else {
        return false;
    };
    if server.contains_key("url") {
        return false;
    }
    let args: Vec<_> = server
        .get("args")
        .and_then(toml::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(toml::Value::as_str)
        .collect();
    args.contains(&"--cli-mcp")
        && std::iter::once(command).chain(args).any(|arg| {
            let name = Path::new(arg).file_name().and_then(OsStr::to_str).unwrap_or_default();
            // Extras follow the exact package name, before any version pin
            // (for example uvx browser-use[cli]==0.13.11 --cli-mcp).
            name == "browser-use"
                || name.starts_with("browser-use[")
                || name.starts_with("browser-use@")
                || name.starts_with("browser-use==")
                || matches!(name, "browser_use" | "browser_use.cli")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_browser_use_stdio_gets_startup_and_existing_settings_survive() {
        let home = tempfile::tempdir().unwrap();
        let config = r#"
[mcp_servers.browser]
command = "/opt/uv"
args = ["tool", "uvx", "--python", "3.12", "browser-use@latest", "--cli-mcp"]
startup_timeout_sec = 90
env = { PYTHONPATH = "/custom modules:/another", KEEP = "unchanged" }
[mcp_servers.direct]
command = "/venv/bin/browser-use"
args = ["--cli-mcp"]
env_vars = ["PYTHONPATH"]
[mcp_servers.module]
command = "python3"
args = ["-m", "browser_use.cli", "--cli-mcp"]
[mcp_servers.other]
command = "python3"
args = ["server.py"]
[mcp_servers.http]
url = "https://example.com/mcp"
[mcp_servers.interactive]
command = "browser-use"
args = ["open", "https://example.com"]
"#;
        let output = configure(config, home.path(), Some(OsStr::new("/forwarded"))).unwrap();
        let original: toml::Table = toml::from_str(config).unwrap();
        let result: toml::Table = toml::from_str(&output).unwrap();
        let servers = &result["mcp_servers"];
        for name in ["other", "http", "interactive"] {
            assert_eq!(servers[name], original["mcp_servers"][name]);
        }
        for name in ["browser", "direct", "module"] {
            assert_eq!(servers[name]["command"], original["mcp_servers"][name]["command"]);
            assert_eq!(servers[name]["args"], original["mcp_servers"][name]["args"]);
        }
        let prefix = home.path().join("browser-use-python").display().to_string();
        assert_eq!(
            servers["browser"]["env"]["PYTHONPATH"].as_str(),
            Some(format!("{prefix}:/custom modules:/another").as_str())
        );
        assert_eq!(servers["direct"]["env"]["PYTHONPATH"].as_str(), Some(format!("{prefix}:/forwarded").as_str()));
        assert_eq!(servers["module"]["env"]["PYTHONPATH"].as_str(), Some(prefix.as_str()));
        assert_eq!(servers["browser"]["env"]["KEEP"].as_str(), Some("unchanged"));
        assert_eq!(servers["browser"]["startup_timeout_sec"].as_integer(), Some(90));
        assert_eq!(
            std::fs::read_to_string(home.path().join("browser-use-python/sitecustomize.py")).unwrap(),
            STARTUP
        );
        assert_eq!(
            configure(&output, home.path(), None).unwrap(),
            output,
            "refreshing a prepared config must not grow PYTHONPATH"
        );
    }

    #[test]
    fn unrelated_configuration_does_not_install_python_startup() {
        let home = tempfile::tempdir().unwrap();
        configure("[mcp_servers.docs]\nurl = 'https://example.com/mcp'", home.path(), None).unwrap();
        assert!(!home.path().join("browser-use-python").exists());
    }

    #[test]
    fn package_extras_receive_startup_without_matching_other_packages() {
        for (package, expected) in [
            ("browser-use[cli]", true),
            ("browser-use[cli]==0.13.11", true),
            ("browser-use[cli]@latest", true),
            ("browser-use[cli,video]>=0.13.11", true),
            ("browser-use-tools[cli]==0.13.11", false),
            ("browser-useful[cli]", false),
            ("other-browser-use[cli]", false),
        ] {
            let home = tempfile::tempdir().unwrap();
            let config = format!("[mcp_servers.browser]\ncommand = 'uvx'\nargs = ['{package}', '--cli-mcp']\n");
            let output = configure(&config, home.path(), None).unwrap();
            let original: toml::Table = toml::from_str(&config).unwrap();
            let result: toml::Table = toml::from_str(&output).unwrap();
            let server = &result["mcp_servers"]["browser"];
            let pythonpath = server.get("env").and_then(|env| env.get("PYTHONPATH")).and_then(toml::Value::as_str);
            let startup = home.path().join("browser-use-python");
            assert_eq!(pythonpath, expected.then_some(startup.to_str().unwrap()), "{package}");
            assert_eq!(startup.join("sitecustomize.py").exists(), expected, "{package}");
            assert_eq!(server["command"], original["mcp_servers"]["browser"]["command"]);
            assert_eq!(server["args"], original["mcp_servers"]["browser"]["args"]);
        }
    }
}
