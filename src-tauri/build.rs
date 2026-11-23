fn main() {
    // Share the homepage with the frontend instead of maintaining a second repo target.
    println!("cargo:rerun-if-changed=../src/lib/repo.ts");
    let repo = std::fs::read_to_string("../src/lib/repo.ts").expect("read repository identity");
    let url = repo.lines().find_map(|line| line.strip_prefix("export const REPO_URL = \"").and_then(|s| s.strip_suffix("\";"))).expect("REPO_URL literal");
    assert!(url.starts_with("https://github.com/"));
    println!("cargo:rustc-env=TERMINALX_REPO_URL={url}");
    embed_cli_skill();
    #[cfg(feature = "desktop")]
    {
        ensure_terminalx_launcher();
        ensure_helper_resource_dirs();
        ensure_local_runtime_resource_dir();
        ensure_agent_browser_stand_in();
    }
    // ggml's Metal backend uses `@available` checks, which compile to a call
    // into clang's builtins runtime. Rust links with `-nodefaultlibs`, so that
    // archive has to be named explicitly or release links fail on
    // `___isPlatformVersionAtLeast`.
    #[cfg(all(target_os = "macos", feature = "desktop"))]
    link_clang_builtins();
    // `terminalx-serve` builds without the desktop feature: no Tauri context,
    // bundle resources or sidecars to check.
    #[cfg(feature = "desktop")]
    {
        tauri_build::build();
        place_tauri_outputs();
    }
}

/// Put the resources and sidecars tauri-build copied where the app looks for
/// them: beside its executable. tauri-build finds that directory three levels
/// above `OUT_DIR`, which is right for Cargo's `build/<pkg>-<hash>/out` but one
/// level short of the `build/<pkg>/<hash>/out` layout newer Cargo uses, where
/// they land in `build/` instead. Only what the merged config names is moved
/// across; under the older layout this does nothing.
#[cfg(feature = "desktop")]
fn place_tauri_outputs() {
    use std::path::{Path, PathBuf};
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    let package = std::env::var("CARGO_PKG_NAME").unwrap_or_default();
    let Some(build) = out.parent().and_then(Path::parent) else { return };
    if build.file_name().and_then(|name| name.to_str()) != Some(package.as_str()) { return; }
    let (Some(copied), Some(profile)) = (build.parent(), build.parent().and_then(Path::parent)) else { return };
    let config = merged_tauri_config();
    let mut names: Vec<PathBuf> = Vec::new();
    match &config["bundle"]["resources"] {
        serde_json::Value::Object(map) => names.extend(map.values().filter_map(|to| to.as_str()).map(PathBuf::from)),
        // A list keeps each source's own path (`../` as `_up_`), which this
        // does not reproduce; the config uses the map form.
        serde_json::Value::Array(_) => println!("cargo:warning=bundle.resources is a list: its resources are not placed beside the app under this Cargo's build layout"),
        _ => {}
    }
    let ext = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") { ".exe" } else { "" };
    if let Some(bins) = config["bundle"]["externalBin"].as_array() {
        names.extend(bins.iter().filter_map(|bin| Path::new(bin.as_str()?).file_name()).map(|name| PathBuf::from(format!("{}{ext}", name.to_string_lossy()))));
    }
    for name in names {
        let name = PathBuf::from(name.to_string_lossy().trim_end_matches(['/', '\\']));
        let from = copied.join(&name);
        if from.exists() {
            if let Err(error) = mirror(&from, &profile.join(&name)) {
                println!("cargo:warning=could not place {} beside the app: {error}", name.display());
            }
        }
    }
}

/// `tauri.conf.json`, then the platform's own, then what the CLI passed in
/// `TAURI_CONFIG`, merged as JSON merge patches the way the CLI merges them.
#[cfg(feature = "desktop")]
fn merged_tauri_config() -> serde_json::Value {
    fn patch(base: &mut serde_json::Value, with: serde_json::Value) {
        match (base, with) {
            (serde_json::Value::Object(base), serde_json::Value::Object(with)) => {
                for (key, value) in with {
                    if value.is_null() { base.remove(&key); } else { patch(base.entry(key).or_insert(serde_json::Value::Null), value); }
                }
            }
            (base, with) => *base = with,
        }
    }
    let read = |path: &str| std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let mut config = read("tauri.conf.json").unwrap_or_default();
    let platform = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() { Ok("windows") => "windows", Ok("macos") => "macos", _ => "linux" };
    if let Some(overlay) = read(&format!("tauri.{platform}.conf.json")) { patch(&mut config, overlay); }
    if let Some(cli) = std::env::var("TAURI_CONFIG").ok().and_then(|text| serde_json::from_str(&text).ok()) { patch(&mut config, cli); }
    config
}

/// Copy `from` (a file or a directory tree) to `to`, replacing what is there.
#[cfg(feature = "desktop")]
fn mirror(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let kind = std::fs::symlink_metadata(from)?.file_type();
    // A link is copied as a link (an app bundle has them), never followed.
    if kind.is_symlink() {
        let _ = std::fs::remove_file(to);
        if let Some(parent) = to.parent() { std::fs::create_dir_all(parent)?; }
        #[cfg(unix)]
        return std::os::unix::fs::symlink(std::fs::read_link(from)?, to);
        #[cfg(not(unix))]
        return Ok(());
    }
    if kind.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            mirror(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::copy(from, to).map(drop)
    }
}

/// `bundle.resources` names the computer-use helper app, and tauri-build
/// refuses a resource path that does not exist. The helper is a Swift build
/// (`pnpm build:computer-macos`) that `cargo test` and `clippy` should not
/// depend on, so an empty stand-in directory is created when it is missing;
/// the runtime then reports the helper as not found instead of the build
/// failing.
#[cfg(feature = "desktop")]
fn ensure_helper_resource_dirs() {
    for output in ["release", "release-dev"] {
        let dir = format!("../native/computer-use-macos/.build/{output}/TerminalX Computer Use Helper.app");
        if !std::path::Path::new(&dir).exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
    }
}

/// Direct cargo checks need the resource directory, not a runnable helper.
/// Tauri's build/dev hook builds and verifies the real executable separately.
/// Never invent a successful background runtime in check-only builds.
#[cfg(feature = "desktop")]
fn ensure_local_runtime_resource_dir() {
    let directory = std::path::Path::new("target/local-runtime");
    if !directory.exists() {
        std::fs::create_dir_all(directory).expect("create local runtime resource directory");
        // Created once: undated, it costs one more rebuild on the next command.
        let _ = date_like(directory, "build.rs");
    }
    println!("cargo:rerun-if-changed=target/local-runtime");
}

fn embed_cli_skill() {
    for source in [
        "../skill-guides/terminalx-cli.md",
        "../skills/terminalx-cli/SKILL.md",
        "../skill-guides/computer-use.md",
        "../skills/computer-use/SKILL.md",
    ] {
        println!("cargo:rerun-if-changed={source}");
        std::fs::read(source).unwrap_or_else(|e| panic!("read embedded file {source}: {e}"));
    }
}

/// `bundle.externalBin` lists the agent-browser sidecar, and tauri-build
/// refuses to build when a listed binary is missing. `cargo test` and clippy
/// must not depend on the 10 MB runtime, so a stand-in that explains itself
/// is written when `scripts/ensure-agent-browser.mjs` has not run. The real
/// copy replaces it before `tauri dev` and `tauri build`.
#[cfg(feature = "desktop")]
fn ensure_agent_browser_stand_in() {
    let triple = std::env::var("TARGET").unwrap_or_default();
    if triple.is_empty() {
        return;
    }
    let ext = if triple.contains("windows") { ".exe" } else { "" };
    let path = std::path::Path::new("binaries").join(format!("agent-browser-{triple}{ext}"));
    println!("cargo:rerun-if-changed={}", path.display());
    if path.exists() {
        return;
    }
    let _ = std::fs::create_dir_all("binaries");
    let stub = "#!/bin/sh\necho '{\"success\":false,\"error\":\"agent-browser is not bundled with this build; run node scripts/ensure-agent-browser.mjs\"}'\nexit 1\n";
    if std::fs::write(&path, stub).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
        // Its text is in this file. Written once: undated, it costs one more rebuild on the next command.
        let _ = date_like(&path, "build.rs");
    }
}

#[cfg(all(target_os = "macos", feature = "desktop"))]
fn link_clang_builtins() {
    use std::path::PathBuf;
    use std::process::Command;
    let Ok(out) = Command::new("xcrun").args(["-f", "clang"]).output() else { return };
    let clang = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    let Some(bin) = clang.parent() else { return };
    let clang_dir = bin.join("../lib/clang");
    let Ok(versions) = std::fs::read_dir(&clang_dir) else { return };
    for v in versions.flatten() {
        let darwin = v.path().join("lib/darwin");
        if darwin.join("libclang_rt.osx.a").exists() {
            println!("cargo:rustc-link-search=native={}", darwin.display());
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
            return;
        }
    }
}

/// Give something this script wrote the time of what it was made from.
/// tauri-build and this script watch what they package. A file written during
/// a run is newer than the run, so the next Cargo command would run the script
/// again and rebuild the whole crate with no source changed. Dated like its
/// source, it reads as changed when the source is.
#[cfg(feature = "desktop")]
fn date_like(written: impl AsRef<std::path::Path>, source: impl AsRef<std::path::Path>) -> std::io::Result<()> {
    let time = std::fs::metadata(source)?.modified()?;
    std::fs::File::open(written)?.set_modified(time)
}

/// Direct Cargo checks also package the real CLI sidecar. No nested Cargo,
/// downloads or success stand-ins; rustc emits the requested target executable.
#[cfg(feature = "desktop")]
fn ensure_terminalx_launcher() {
    let target = std::env::var("TARGET").expect("Cargo target");
    if !target.ends_with("-apple-darwin") { return; }
    let source = "../native/terminalx-launcher/main.rs";
    println!("cargo:rerun-if-changed={source}");
    let output = format!("binaries/terminalx-{target}");
    let temporary = format!("{output}.tmp-{}", std::process::id());
    std::fs::create_dir_all("binaries").expect("create sidecar directory");
    let status = std::process::Command::new(std::env::var_os("RUSTC").expect("Cargo rustc"))
        .args(["--edition=2021", "--crate-name", "terminalx_launcher", "--target", &target,
            "-C", if std::env::var("PROFILE").as_deref() == Ok("debug") { "opt-level=0" } else { "opt-level=2" },
            source, "-o", &temporary])
        .status().expect("build native CLI launcher");
    if !status.success() {
        let _ = std::fs::remove_file(&temporary);
        panic!("native CLI launcher build failed");
    }
    // Rewritten on every run, so undated it would read as changed after every build.
    if let Err(error) = date_like(&temporary, source) {
        println!("cargo:warning=the CLI launcher keeps this build's time, so the next Cargo command rebuilds the crate: {error}");
    }
    std::fs::rename(&temporary, &output).expect("publish native CLI launcher");
}
