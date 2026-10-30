//! Seeder core against real, disposable APFS disk images attached without
//! privilege. No VM disk, restore image or system volume is involved. Owners
//! are this user's: only root can write root:wheel items (see the design's
//! fixture finding), so root ownership stays for the approved acceptance run.
#![cfg(target_os = "macos")]
use std::{path::Path, process::Command};
use terminalx_vm_bootstrap::{fsx::Dir, seed};

fn hdiutil(args: &[&str]) {
    let output = Command::new("/usr/bin/hdiutil")
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "hdiutil {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A 64 MiB APFS image, detached on drop.
struct Image {
    _temp: tempfile::TempDir,
    image: String,
    mounted: Option<String>,
}

impl Image {
    fn new() -> Image {
        let temp = tempfile::tempdir().unwrap();
        let image = temp
            .path()
            .join("fixture.dmg")
            .to_string_lossy()
            .into_owned();
        hdiutil(&[
            "create",
            "-quiet",
            "-size",
            "64m",
            "-fs",
            "APFS",
            "-volname",
            "TXSeedFixture",
            "-type",
            "UDIF",
            &image,
        ]);
        Image {
            _temp: temp,
            image,
            mounted: None,
        }
    }

    fn attach(&mut self, at: &Path, options: &[&str]) {
        let at = at.to_string_lossy().into_owned();
        let mut args = vec![
            "attach",
            "-quiet",
            "-nobrowse",
            "-noautoopen",
            "-mountpoint",
            &at,
        ];
        args.extend_from_slice(options);
        args.push(&self.image);
        hdiutil(&args);
        self.mounted = Some(at);
    }

    fn detach(&mut self) {
        if let Some(at) = self.mounted.take() {
            hdiutil(&["detach", "-quiet", &at]);
        }
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        if let Some(at) = self.mounted.take() {
            let _ = Command::new("/usr/bin/hdiutil")
                .args(["detach", "-force", "-quiet", &at])
                .status();
        }
    }
}

fn me() -> seed::Owner {
    // SAFETY: no preconditions.
    unsafe {
        seed::Owner {
            uid: libc::geteuid(),
            gid: libc::getegid(),
        }
    }
}

const CONTENT: [&[u8]; 3] = [
    b"<plist/>",
    b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01 probe",
    b"{\"key\":1}",
];

#[test]
fn seeds_on_a_writable_owned_mount_and_reads_back_after_a_read_only_remount() {
    let mut image = Image::new();
    let mount = tempfile::tempdir().unwrap();
    image.attach(mount.path(), &["-owners", "on"]);
    let (volume, info) = seed::open_volume(mount.path(), true).unwrap();
    assert!(info.ownership() && !info.read_only());
    let receipt = seed::seed(&volume, &seed::VALIDATION, CONTENT, me()).unwrap();
    assert_eq!(receipt["device"], volume.stat.st_dev);
    assert!(
        seed::open_volume(mount.path(), false).is_err(),
        "readback refuses a writable mount"
    );
    drop(volume);
    image.detach();

    image.attach(mount.path(), &["-readonly", "-owners", "on"]);
    let (volume, info) = seed::open_volume(mount.path(), false).unwrap();
    assert!(info.read_only());
    assert!(
        seed::open_volume(mount.path(), true).is_err(),
        "seeding refuses a read-only mount"
    );
    let mut receipt = receipt;
    receipt["device"] = volume.stat.st_dev.into(); // a new attachment has a new device number
    let report = seed::readback(&volume, &seed::VALIDATION, &receipt).unwrap();
    assert_eq!(report["matchesReceipt"], true);
}

#[test]
fn refuses_mounts_that_ignore_ownership() {
    let mut image = Image::new();
    let mount = tempfile::tempdir().unwrap();
    image.attach(mount.path(), &["-owners", "off"]);
    let error = seed::open_volume(mount.path(), true).err().unwrap();
    assert!(error.0.contains("ownership is ignored"), "{error}");
}

#[test]
fn refuses_to_cross_onto_another_device() {
    let mut image = Image::new();
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(root.path().join("private/var/db")).unwrap();
    std::fs::create_dir(root.path().join("Library")).unwrap();
    // The image is mounted where the seeder expects the volume's own Library.
    image.attach(&root.path().join("Library"), &["-owners", "on"]);
    let volume = Dir::open_root(root.path()).unwrap();
    let error = seed::seed(&volume, &seed::VALIDATION, CONTENT, me()).unwrap_err();
    assert!(error.0.contains("another device"), "{error}");
    let foreign = Dir::open_root(&root.path().join("Library")).unwrap();
    assert!(
        foreign.stat_at("LaunchDaemons").unwrap().is_none(),
        "nothing created on the foreign device"
    );
}

#[test]
fn root_items_need_root_and_nothing_is_written_without_it() {
    // SAFETY: no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return; // this check is about the unprivileged path only
    }
    let mut image = Image::new();
    let mount = tempfile::tempdir().unwrap();
    image.attach(mount.path(), &["-owners", "on"]);
    let (volume, _) = seed::open_volume(mount.path(), true).unwrap();
    let error = seed::seed(&volume, &seed::VALIDATION, CONTENT, seed::Owner::ROOT).unwrap_err();
    assert!(error.0.contains("nothing was written"), "{error}");
    assert!(volume.stat_at("Library").unwrap().is_none());
}
