fn main() {
    // Share the homepage with the frontend instead of maintaining a second repo target.
    println!("cargo:rerun-if-changed=../src/lib/repo.ts");
    let repo = std::fs::read_to_string("../src/lib/repo.ts").expect("read repository identity");
    let url = repo.lines().find_map(|line| line.strip_prefix("export const REPO_URL = \"").and_then(|s| s.strip_suffix("\";"))).expect("REPO_URL literal");
    assert!(url.starts_with("https://github.com/"));
    println!("cargo:rustc-env=TERMINALX_REPO_URL={url}");
    embed_cli_skill();
    ensure_helper_resource_dirs();
    ensure_agent_browser_stand_in();
    // ggml's Metal backend uses `@available` checks, which compile to a call
    // into clang's builtins runtime. Rust links with `-nodefaultlibs`, so that
    // archive has to be named explicitly or release links fail on
    // `___isPlatformVersionAtLeast`.
    #[cfg(target_os = "macos")]
    link_clang_builtins();
    tauri_build::build()
}

/// `bundle.resources` names the computer-use helper app, and tauri-build
/// refuses a resource path that does not exist. The helper is a Swift build
/// (`pnpm build:computer-macos`) that `cargo test` and `clippy` should not
/// depend on, so an empty stand-in directory is created when it is missing;
/// the runtime then reports the helper as not found instead of the build
/// failing.
fn ensure_helper_resource_dirs() {
    for output in ["release", "release-dev"] {
        let dir = format!("../native/computer-use-macos/.build/{output}/TerminalX Computer Use.app");
        if !std::path::Path::new(&dir).exists() {
            let _ = std::fs::create_dir_all(&dir);
        }
    }
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
    }
}

#[cfg(target_os = "macos")]
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
