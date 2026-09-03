fn main() {
    embed_cli_skill();
    // ggml's Metal backend uses `@available` checks, which compile to a call
    // into clang's builtins runtime. Rust links with `-nodefaultlibs`, so that
    // archive has to be named explicitly or release links fail on
    // `___isPlatformVersionAtLeast`.
    #[cfg(target_os = "macos")]
    link_clang_builtins();
    tauri_build::build()
}

fn embed_cli_skill() {
    for source in ["../skill-guides/terminalx-cli.md", "../skills/terminalx-cli/SKILL.md"] {
        println!("cargo:rerun-if-changed={source}");
        std::fs::read(source).unwrap_or_else(|e| panic!("read embedded file {source}: {e}"));
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
