#!/bin/bash
# Run by hand on the logged-in Mac with Touch ID enrolled.
# approve: compare program/argv/cwd in both prompts, then authenticate.
# expire: leave the first alert unanswered, or continue and leave Touch ID unanswered.
# Either sheet should dismiss on its own 15 seconds after the request starts.
# The probe prints the final approval state and never starts the command.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-approve}"
case "$mode" in approve|expire|build-only) ;; *) exit 2 ;; esac
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/src"
cp "$root/src-tauri/src/host_command_policy.rs" "$scratch/src/main.rs"
ln -s "$root/src-tauri/src/host_command_executor.rs" "$scratch/src/"
ln -s "$root/src-tauri/src/host_command_executor_macos.rs" "$scratch/src/"
cat > "$scratch/Cargo.toml" <<'TOML'
[package]
name = "pro220-touchid-live-check"
version = "0.0.0"
edition = "2021"

[features]
default = ["desktop"]
desktop = []

[dependencies]
block2 = "=0.6.2"
objc2 = "=0.6.4"
objc2-app-kit = { version = "=0.3.2", default-features = false, features = ["std", "NSAlert", "NSApplication", "NSButton", "NSControl", "NSResponder", "NSView", "NSWindow", "NSGraphics", "NSRunningApplication", "block2"] }
objc2-foundation = { version = "=0.3.2", default-features = false, features = ["std", "NSString", "NSError", "NSGeometry"] }
TOML
cat >> "$scratch/src/main.rs" <<'RUST'

fn main() {
    let main = objc2::MainThreadMarker::new().expect("AppKit main thread");
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let app = NSApplication::sharedApplication(main);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    // SAFETY: the fixture creates and retains a main-thread AppKit window.
    let window = unsafe { NSWindow::initWithContentRect_styleMask_backing_defer(
        main.alloc(), NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(540.0, 260.0)),
        NSWindowStyleMask::Titled, NSBackingStoreType::Buffered, false,
    ) };
    window.setTitle(&objc2_foundation::NSString::from_str("PRO-220 Touch ID fixture"));
    window.makeKeyAndOrderFront(None);
    app.activate();
    let origin = Origin {
        mac: "fixture-mac".into(), account: "fixture-owner".into(),
        organization: "fixture-org".into(), workspace: "fixture-workspace".into(),
        tab: "fixture-tab".into(), turn: "fixture-turn".into(),
    };
    let policy = Policy::default();
    policy.update_trusted_context(TrustedContext {
        enabled: Some(true), local_mac: Some(origin.mac.clone()),
        local_account: Some(origin.account.clone()), origin: Some(origin.clone()),
        generation: Some(1), approval_revision: Some(1),
        can_approve: Some(true), turn_active: Some(true), cwd_root: Some("/private/tmp".into()),
    }).unwrap();
    let expires = std::env::args().nth(1).as_deref() == Some("expire");
    let request = policy.submit(RequestInput {
        id: "touch-id-check".into(), origin, generation: 1, approval_revision: 1,
        ttl_ms: if expires { 15_000 } else { 60_000 }, executable: "/usr/bin/printf".into(),
        arguments: vec!["%s".into(), "Touch ID fixture".into()], cwd: "/private/tmp".into(),
        timeout_ms: 1000, output_limit_bytes: 64,
    }).unwrap();
    let reply = policy.prompt_once(&request, &window).expect("could not present the fixture");
    std::thread::spawn(move || {
        let result = match reply.recv() {
            Ok(result) => result,
            Err(error) => {
                eprintln!("consent sheet disconnected: {error}");
                std::process::exit(1);
            }
        };
        println!("Consent: {result:?}, state: {:?}", request.state());
        std::process::exit(0);
    });
    app.run();
}
RUST
cd "$root"
export RUSTFLAGS="${RUSTFLAGS:-} -A dead_code"
if [[ "$mode" == build-only ]]; then
  cargo build --manifest-path "$scratch/Cargo.toml" --offline -j 1
else
  cargo run --manifest-path "$scratch/Cargo.toml" --offline -j 1 -- "$mode"
fi
