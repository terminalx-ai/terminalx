//! Entry-point isolation for the packaged native helper. These tests deliberately
//! supply an invalid application id: even a routing regression fails before
//! NSApplication is created, so no test touches the host GUI.
#![cfg(all(target_os = "macos", feature = "local-ui"))]
mod common;
use common::agent::AgentWorld;

#[test]
fn local_helper_self_test_ignores_inherited_desktop_activation() {
    let world = AgentWorld::new();
    let output = world.command().arg("--self-test")
        .env("TERMINALX_LOCAL_DESKTOP","1")
        .env("TERMINALX_LOCAL_APPLICATION",":invalid:")
        .env("SHELL","/bin/sh")
        .env("ZDOTDIR",&world.home)
        .output().unwrap();
    assert!(output.status.success(),"self-test failed: {}",String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("\"pty\":\"ok\""));
}

#[test]
fn local_native_start_rejects_invalid_application_identity_before_opening_appkit() {
    let world = AgentWorld::new();
    let output = world.command()
        .env("TERMINALX_LOCAL_DESKTOP","1")
        .env("TERMINALX_LOCAL_APPLICATION",":invalid:")
        .stderr(std::process::Stdio::piped())
        .output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("application identifier is invalid"));
    assert!(!world.data.join("run/hooks.sock").exists());
}
