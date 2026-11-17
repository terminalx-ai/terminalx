//! Offline seed of the three first-boot items onto a stopped guest's mounted
//! Data volume (design "Seeder contract" steps 3-5): pristine checks, exclusive
//! descriptor-relative writes with an explicit owner and mode, a same-device
//! check on every directory, and a readback receipt. Attaching and mounting
//! the disk image belong to the caller; nothing here deletes or repairs.
use crate::fsx::{self, Dir};
use serde_json::{json, Value};
use std::{
    ffi::{CStr, CString},
    io::{self, Read, Write},
    os::{fd::AsRawFd, unix::ffi::OsStrExt},
    path::Path,
};

#[derive(Debug)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refusal(context: &str, error: io::Error) -> Refusal {
    Refusal(format!("{context}: {error}"))
}

pub struct Item {
    pub key: &'static str,
    pub dirs: &'static [&'static str],
    pub name: &'static str,
    pub mode: libc::mode_t,
    /// The item's own directory is created 0700 instead of 0755.
    pub private_dir: bool,
    pub limit: usize,
}

pub struct Profile {
    pub name: &'static str,
    pub items: [Item; 3],
    /// Directories that belong only to this profile; any of them existing
    /// means the volume was already seeded or tampered with.
    pub owned: [(&'static [&'static str], &'static str); 2],
}

pub const VALIDATION: Profile = Profile {
    name: "validation",
    items: [
        Item {
            key: "plist",
            dirs: &["Library", "LaunchDaemons"],
            name: "com.terminalx.next.vm-validation-probe.plist",
            mode: 0o644,
            private_dir: false,
            limit: 4096,
        },
        Item {
            key: "program",
            dirs: &[
                "Library",
                "Application Support",
                "TerminalX",
                "VMValidation",
            ],
            name: "terminalx-vm-validation-probe",
            mode: 0o755,
            private_dir: false,
            limit: 64 << 20,
        },
        Item {
            key: "key",
            dirs: &["private", "var", "db", "com.terminalx.next.vm-validation"],
            name: "enrollment.json",
            mode: 0o600,
            private_dir: true,
            limit: 4096,
        },
    ],
    owned: [
        (&["Library", "Application Support"], "TerminalX"),
        (
            &["private", "var", "db"],
            "com.terminalx.next.vm-validation",
        ),
    ],
};

/// The design's production layout. Seeding it needs the signed helper, which
/// does not exist yet; it is defined so either profile's presence refuses.
pub const PRODUCTION: Profile = Profile {
    name: "production",
    items: [
        Item {
            key: "plist",
            dirs: &["Library", "LaunchDaemons"],
            name: "com.terminalx.next.vm-bootstrap.plist",
            mode: 0o644,
            private_dir: false,
            limit: 4096,
        },
        Item {
            key: "program",
            dirs: &["Library", "Application Support", "TerminalX", "VMBootstrap"],
            name: "terminalx-vm-bootstrap",
            mode: 0o755,
            private_dir: false,
            limit: 64 << 20,
        },
        Item {
            key: "key",
            dirs: &["private", "var", "db", "com.terminalx.next.vm-bootstrap"],
            name: "enrollment.json",
            mode: 0o600,
            private_dir: true,
            limit: 4096,
        },
    ],
    owned: [
        (&["Library", "Application Support"], "TerminalX"),
        (&["private", "var", "db"], "com.terminalx.next.vm-bootstrap"),
    ],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Owner {
    pub uid: u32,
    pub gid: u32,
}

impl Owner {
    /// `root:wheel`, the only owner launchd accepts for a LaunchDaemon.
    pub const ROOT: Owner = Owner { uid: 0, gid: 0 };
}

fn path(dirs: &[&str], name: &str) -> String {
    format!("/{}/{name}", dirs.join("/"))
}

/// Opens `dirs` without following links; a missing directory is `None`.
fn existing(volume: &Dir, dirs: &[&str]) -> io::Result<Option<Dir>> {
    match volume.walk(dirs, |_, _| Ok(())) {
        Ok(dir) => Ok(Some(dir)),
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Ok(None),
        Err(e) => Err(e),
    }
}

fn exists(volume: &Dir, dirs: &[&str], name: &str) -> io::Result<bool> {
    Ok(match existing(volume, dirs)? {
        Some(dir) => dir.stat_at(name)?.is_some(),
        None => false,
    })
}

/// Design step 3: no completed Setup Assistant, no personal account records or
/// homes, and neither TerminalX profile present. The users directory is only
/// readable by root on a real guest volume, so a non-root caller is refused.
pub fn pristine(volume: &Dir) -> Result<Value, Refusal> {
    let db = ["private", "var", "db"];
    if exists(volume, &db, ".AppleSetupDone").map_err(|e| refusal("Setup Assistant marker", e))? {
        return Err(Refusal(
            "Setup Assistant already completed on this volume".into(),
        ));
    }
    let users = existing(
        volume,
        &[
            "private", "var", "db", "dslocal", "nodes", "Default", "users",
        ],
    )
    .map_err(|e| refusal("local user records", e))?;
    let records = match &users {
        Some(dir) => dir
            .entries()
            .map_err(|e| refusal("local user records", e))?,
        None => Vec::new(),
    };
    let personal: Vec<&String> = records
        .iter()
        .filter(|name| {
            let stem = name.strip_suffix(".plist").unwrap_or(name);
            !(stem.starts_with('_') || ["root", "daemon", "nobody"].contains(&stem))
        })
        .collect();
    if !personal.is_empty() {
        return Err(Refusal(format!(
            "personal account records exist: {personal:?}"
        )));
    }
    let homes = match existing(volume, &["Users"]).map_err(|e| refusal("Users", e))? {
        Some(dir) => dir.entries().map_err(|e| refusal("Users", e))?,
        None => Vec::new(),
    };
    if let Some(home) = homes
        .iter()
        .find(|h| !["Shared", ".localized"].contains(&h.as_str()))
    {
        return Err(Refusal(format!("a home directory exists: /Users/{home}")));
    }
    for profile in [&VALIDATION, &PRODUCTION] {
        let found = profile
            .owned
            .iter()
            .map(|(dirs, name)| (*dirs, *name))
            .chain(profile.items.iter().map(|item| (item.dirs, item.name)));
        for (dirs, name) in found {
            if exists(volume, dirs, name).map_err(|e| refusal("TerminalX paths", e))? {
                return Err(Refusal(format!("{} already exists", path(dirs, name))));
            }
        }
    }
    Ok(json!({"setupDone": false, "systemUserRecords": records.len(), "usersEntries": homes}))
}

fn same_device(volume: &Dir, dir: &Dir, name: &str) -> io::Result<()> {
    if dir.stat.st_dev != volume.stat.st_dev {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{name} is on another device"),
        ));
    }
    Ok(())
}

fn set_owner_mode(fd: i32, owner: Owner, mode: libc::mode_t) -> io::Result<()> {
    // SAFETY: fd is an open descriptor owned by the caller.
    if unsafe { libc::fchown(fd, owner.uid, owner.gid) } != 0
        || unsafe { libc::fchmod(fd, mode) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Opens or creates each directory of `dirs`. Existing ones must be the
/// owner's, on the volume's device and not group/world writable; new ones get
/// the owner and 0755, or 0700 for a private final directory.
fn ensure(volume: &Dir, item: &Item, owner: Owner, created: &mut Vec<String>) -> io::Result<Dir> {
    let mut current: Option<Dir> = None;
    for (index, name) in item.dirs.iter().enumerate() {
        let parent = current.as_ref().unwrap_or(volume);
        let last = index + 1 == item.dirs.len();
        let next = match parent.stat_at(name)? {
            None => {
                // Create closed, then set the real owner and mode by descriptor.
                parent.make_dir(name, 0o700)?;
                let dir = parent.open_dir(name)?;
                set_owner_mode(
                    dir.fd(),
                    owner,
                    if last && item.private_dir {
                        0o700
                    } else {
                        0o755
                    },
                )?;
                created.push(format!("/{}", item.dirs[..=index].join("/")));
                parent.open_dir(name)?
            }
            Some(_) => {
                let dir = parent.open_dir(name)?;
                if dir.stat.st_uid != owner.uid || dir.stat.st_mode & 0o022 != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!("existing {name} is not owner-only writable"),
                    ));
                }
                dir
            }
        };
        same_device(volume, &next, name)?;
        current = Some(next);
    }
    current.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "item without a directory"))
}

/// Design step 4. Writes each item exclusively, sets its owner and mode by
/// descriptor and syncs it. A failure part-way leaves what was written for the
/// readback to judge; nothing is deleted or retried.
pub fn seed(
    volume: &Dir,
    profile: &Profile,
    contents: [&[u8]; 3],
    owner: Owner,
) -> Result<Value, Refusal> {
    // SAFETY: geteuid has no preconditions.
    let euid = unsafe { libc::geteuid() };
    if euid != 0 && euid != owner.uid {
        return Err(Refusal(format!(
            "uid {euid} cannot give items to uid {}; nothing was written",
            owner.uid
        )));
    }
    let checked = pristine(volume)?;
    for (item, bytes) in profile.items.iter().zip(contents) {
        if bytes.is_empty() || bytes.len() > item.limit {
            return Err(Refusal(format!(
                "{} content outside 1...{} bytes",
                item.key, item.limit
            )));
        }
    }
    let mut created = Vec::new();
    let mut items = Vec::new();
    for (item, bytes) in profile.items.iter().zip(contents) {
        let at = path(item.dirs, item.name);
        let dir = ensure(volume, item, owner, &mut created).map_err(|e| refusal(&at, e))?;
        let mut file = dir
            .create_new(item.name, 0o600)
            .map_err(|e| refusal(&at, e))?;
        set_owner_mode(file.as_raw_fd(), owner, item.mode).map_err(|e| refusal(&at, e))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| refusal(&at, e))?;
        let xattrs = attributes(&file, &at)?;
        items.push(json!({"key": item.key, "path": at, "uid": owner.uid, "gid": owner.gid,
            "mode": format!("{:04o}", item.mode), "size": bytes.len(), "sha256": crate::sha256(bytes), "xattrs": xattrs}));
    }
    Ok(
        json!({"version": 1, "profile": profile.name, "device": volume.stat.st_dev, "pristine": checked,
        "createdDirectories": created, "items": items}),
    )
}

/// The kernel tags files written by a provenance-tracked process with
/// `com.apple.provenance`, and the writer cannot remove it. That one name is
/// recorded and compared; any other attribute, notably quarantine, refuses.
pub const ALLOWED_XATTRS: [&str; 1] = ["com.apple.provenance"];

fn attributes(file: &std::fs::File, at: &str) -> Result<Vec<String>, Refusal> {
    let names = fsx::xattr_names(file.as_raw_fd()).map_err(|e| refusal(at, e))?;
    if let Some(name) = names.iter().find(|n| !ALLOWED_XATTRS.contains(&n.as_str())) {
        return Err(Refusal(format!("{at} carries extended attribute {name}")));
    }
    Ok(names)
}

/// Design step 5: every item read back by descriptor and compared with the
/// receipt — owner, mode, size, digest, extended attribute names, one link,
/// no flags — plus each item directory's owner and mode.
pub fn readback(volume: &Dir, profile: &Profile, receipt: &Value) -> Result<Value, Refusal> {
    if receipt["profile"] != profile.name {
        return Err(Refusal("receipt is for another profile".into()));
    }
    let mut observed = Vec::new();
    let mut differences = Vec::new();
    for item in &profile.items {
        let at = path(item.dirs, item.name);
        let Some(expected) = receipt["items"]
            .as_array()
            .and_then(|items| items.iter().find(|i| i["key"] == item.key))
        else {
            return Err(Refusal(format!("receipt has no {}", item.key)));
        };
        let dir = volume
            .walk(item.dirs, |name, dir| same_device(volume, dir, name))
            .map_err(|e| refusal(&at, e))?;
        let (mut file, stat) = dir.open_regular(item.name).map_err(|e| refusal(&at, e))?;
        let xattrs = fsx::xattr_names(file.as_raw_fd()).map_err(|e| refusal(&at, e))?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(item.limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| refusal(&at, e))?;
        let actual = json!({"key": item.key, "path": at, "uid": stat.st_uid, "gid": stat.st_gid,
            "mode": format!("{:04o}", stat.st_mode & 0o7777), "size": bytes.len(), "sha256": crate::sha256(&bytes),
            "xattrs": xattrs});
        let dir_mode = dir.stat.st_mode & 0o7777;
        let dir_ok = expected["uid"].as_u64() == Some(dir.stat.st_uid.into())
            && dir_mode & 0o022 == 0
            && (!item.private_dir || dir_mode & 0o077 == 0);
        if actual != *expected || stat.st_nlink != 1 || stat.st_flags != 0 || !dir_ok {
            differences.push(json!({"key": item.key, "expected": expected, "actual": actual, "links": stat.st_nlink,
                "flags": stat.st_flags, "directoryUid": dir.stat.st_uid,
                "directoryMode": format!("{:04o}", dir.stat.st_mode & 0o7777)}));
        }
        observed.push(actual);
    }
    if !differences.is_empty() {
        return Err(Refusal(format!(
            "readback differs: {}",
            Value::Array(differences)
        )));
    }
    Ok(
        json!({"version": 1, "profile": profile.name, "device": volume.stat.st_dev, "items": observed, "matchesReceipt": true}),
    )
}

/// How the volume is mounted, from statfs.
pub struct Mount {
    pub path: String,
    pub fs_type: String,
    pub flags: u32,
}

impl Mount {
    pub fn read_only(&self) -> bool {
        self.flags & libc::MNT_RDONLY as u32 != 0
    }
    pub fn ownership(&self) -> bool {
        self.flags & libc::MNT_IGNORE_OWNERSHIP as u32 == 0
    }
    pub fn to_json(&self) -> Value {
        json!({"mountPoint": self.path, "type": self.fs_type, "readOnly": self.read_only(), "ownership": self.ownership(),
            "nosuid": self.flags & libc::MNT_NOSUID as u32 != 0, "nodev": self.flags & libc::MNT_NODEV as u32 != 0,
            "nobrowse": self.flags & libc::MNT_DONTBROWSE as u32 != 0})
    }
}

pub fn mount(path: &Path) -> io::Result<Mount> {
    let c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: valid C path and writable statfs storage.
    if unsafe { libc::statfs(c.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statfs succeeded and initialized the structure.
    let stat = unsafe { stat.assume_init() };
    // SAFETY: both names are NUL-terminated fixed arrays filled by the kernel.
    let text = |chars: &[libc::c_char]| {
        unsafe { CStr::from_ptr(chars.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    };
    Ok(Mount {
        path: text(&stat.f_mntonname),
        fs_type: text(&stat.f_fstypename),
        flags: stat.f_flags,
    })
}

/// Opens the Data volume's root after checking how it is mounted: exactly its
/// mount point, APFS, ownership honored, and either writable with nosuid and
/// nodev (seeding) or read-only (inspection and readback).
pub fn open_volume(path: &Path, writable: bool) -> Result<(Dir, Mount), Refusal> {
    let canonical = path.canonicalize().map_err(|e| refusal("volume", e))?;
    let mount = mount(&canonical).map_err(|e| refusal("volume", e))?;
    if Path::new(&mount.path) != canonical {
        return Err(Refusal(format!(
            "{} is not a mount point",
            canonical.display()
        )));
    }
    if mount.fs_type != "apfs" {
        return Err(Refusal(format!("volume is {}, not apfs", mount.fs_type)));
    }
    if !mount.ownership() {
        return Err(Refusal(
            "ownership is ignored on this mount; owners would not be written exactly".into(),
        ));
    }
    let suid_dev = mount.flags & (libc::MNT_NOSUID | libc::MNT_NODEV) as u32
        == (libc::MNT_NOSUID | libc::MNT_NODEV) as u32;
    if writable && (mount.read_only() || !suid_dev) {
        return Err(Refusal(
            "seeding needs a writable mount with nosuid and nodev".into(),
        ));
    }
    if !writable && !mount.read_only() {
        return Err(Refusal(
            "inspection and readback need a read-only mount".into(),
        ));
    }
    let dir = Dir::open_root(&canonical).map_err(|e| refusal("volume", e))?;
    Ok((dir, mount))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn me() -> Owner {
        // SAFETY: no preconditions.
        unsafe {
            Owner {
                uid: libc::geteuid(),
                gid: libc::getegid(),
            }
        }
    }

    /// A disposable tree shaped like a restored, never-booted Data volume.
    fn volume() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        for dir in [
            "Library",
            "private/var/db/dslocal/nodes/Default/users",
            "Users/Shared",
        ] {
            std::fs::create_dir_all(temp.path().join(dir)).unwrap();
        }
        for name in ["_spotlight", "root", "daemon", "nobody"] {
            std::fs::write(
                temp.path().join(format!(
                    "private/var/db/dslocal/nodes/Default/users/{name}.plist"
                )),
                b"",
            )
            .unwrap();
        }
        temp
    }

    const CONTENT: [&[u8]; 3] = [b"<plist/>", b"\xcf\xfa\xed\xfe probe", b"{\"key\":1}"];

    #[test]
    fn seeds_exact_items_and_reads_them_back() {
        let temp = volume();
        let root = Dir::open_root(temp.path()).unwrap();
        let receipt = seed(&root, &VALIDATION, CONTENT, me()).unwrap();
        assert_eq!(receipt["items"].as_array().unwrap().len(), 3);
        assert_eq!(
            receipt["createdDirectories"],
            json!([
                "/Library/LaunchDaemons",
                "/Library/Application Support",
                "/Library/Application Support/TerminalX",
                "/Library/Application Support/TerminalX/VMValidation",
                "/private/var/db/com.terminalx.next.vm-validation"
            ])
        );
        let key = temp
            .path()
            .join("private/var/db/com.terminalx.next.vm-validation");
        assert_eq!(
            std::fs::metadata(&key).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(key.join("enrollment.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );
        let program = temp.path().join(
            "Library/Application Support/TerminalX/VMValidation/terminalx-vm-validation-probe",
        );
        assert_eq!(
            std::fs::metadata(&program).unwrap().permissions().mode() & 0o7777,
            0o755
        );
        assert_eq!(receipt["items"][1]["sha256"], crate::sha256(CONTENT[1]));
        let report = readback(&root, &VALIDATION, &receipt).unwrap();
        assert_eq!(report["matchesReceipt"], true);
        let error = seed(&root, &VALIDATION, CONTENT, me()).unwrap_err();
        assert!(error.0.contains("already exists"), "never reseeds: {error}");
    }

    #[test]
    fn refuses_volumes_that_are_not_pristine() {
        type Mutate = fn(&Path);
        let cases: [(Mutate, &str); 5] = [
            (
                |r| std::fs::write(r.join("private/var/db/.AppleSetupDone"), b"").unwrap(),
                "Setup Assistant",
            ),
            (
                |r| {
                    std::fs::write(
                        r.join("private/var/db/dslocal/nodes/Default/users/alice.plist"),
                        b"",
                    )
                    .unwrap()
                },
                "personal account",
            ),
            (
                |r| std::fs::create_dir(r.join("Users/alice")).unwrap(),
                "home directory",
            ),
            (
                |r| {
                    std::fs::create_dir_all(r.join("Library/Application Support/TerminalX"))
                        .unwrap()
                },
                "already exists",
            ),
            (
                |r| {
                    std::fs::create_dir_all(
                        r.join("private/var/db/com.terminalx.next.vm-bootstrap"),
                    )
                    .unwrap()
                },
                "already exists",
            ),
        ];
        for (mutate, reason) in cases {
            let temp = volume();
            mutate(temp.path());
            let root = Dir::open_root(temp.path()).unwrap();
            let error = seed(&root, &VALIDATION, CONTENT, me()).unwrap_err();
            assert!(error.0.contains(reason), "{reason}: {error}");
            assert!(
                !temp.path().join("Library/LaunchDaemons").exists(),
                "{reason}: nothing written"
            );
        }
    }

    #[test]
    fn never_writes_through_links_or_open_directories() {
        let temp = volume();
        let outside = tempfile::tempdir().unwrap();
        symlink(outside.path(), temp.path().join("Library/LaunchDaemons")).unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        let error = seed(&root, &VALIDATION, CONTENT, me()).unwrap_err();
        assert!(
            error.0.contains("Not a directory") || error.0.contains("Too many levels"),
            "{error}"
        );
        assert_eq!(
            std::fs::read_dir(outside.path()).unwrap().count(),
            0,
            "nothing written outside"
        );
        assert!(
            !temp.path().join("Library/Application Support").exists(),
            "refused before the first write"
        );

        let temp = volume();
        std::fs::create_dir(temp.path().join("Library/LaunchDaemons")).unwrap();
        std::fs::set_permissions(
            temp.path().join("Library/LaunchDaemons"),
            std::fs::Permissions::from_mode(0o777),
        )
        .unwrap();
        let root = Dir::open_root(temp.path()).unwrap();
        let error = seed(&root, &VALIDATION, CONTENT, me()).unwrap_err();
        assert!(error.0.contains("not owner-only writable"), "{error}");
    }

    #[test]
    fn content_bounds_are_checked_before_any_write() {
        let temp = volume();
        let root = Dir::open_root(temp.path()).unwrap();
        let big = vec![0u8; 4097];
        assert!(seed(&root, &VALIDATION, [b"", CONTENT[1], CONTENT[2]], me()).is_err());
        assert!(seed(&root, &VALIDATION, [CONTENT[0], CONTENT[1], &big], me()).is_err());
        assert!(!temp.path().join("Library/LaunchDaemons").exists());
    }

    #[test]
    fn readback_reports_tampering() {
        type Mutate = fn(&Path);
        let program =
            "Library/Application Support/TerminalX/VMValidation/terminalx-vm-validation-probe";
        let cases: [Mutate; 4] = [
            |r| {
                std::fs::write(r.join("Library/Application Support/TerminalX/VMValidation/terminalx-vm-validation-probe"), b"changed!!").unwrap()
            },
            |r| {
                std::fs::set_permissions(
                    r.join("Library/LaunchDaemons/com.terminalx.next.vm-validation-probe.plist"),
                    std::fs::Permissions::from_mode(0o666),
                )
                .unwrap()
            },
            |r| {
                std::fs::hard_link(
                    r.join("private/var/db/com.terminalx.next.vm-validation/enrollment.json"),
                    r.join("copy"),
                )
                .unwrap()
            },
            |r| {
                let status =
                    std::process::Command::new("/usr/bin/xattr")
                        .args(["-w", "com.apple.quarantine", "0081;00000000;x;"])
                        .arg(r.join(
                            "Library/LaunchDaemons/com.terminalx.next.vm-validation-probe.plist",
                        ))
                        .status()
                        .unwrap();
                assert!(status.success());
            },
        ];
        for (index, mutate) in cases.into_iter().enumerate() {
            let temp = volume();
            let root = Dir::open_root(temp.path()).unwrap();
            let receipt = seed(&root, &VALIDATION, CONTENT, me()).unwrap();
            mutate(temp.path());
            let error = readback(&root, &VALIDATION, &receipt).unwrap_err();
            assert!(
                error.0.starts_with("readback differs"),
                "case {index}: {error}"
            );
        }
        let temp = volume();
        let root = Dir::open_root(temp.path()).unwrap();
        let receipt = seed(&root, &VALIDATION, CONTENT, me()).unwrap();
        std::fs::remove_file(temp.path().join(program)).unwrap();
        symlink("/usr/bin/true", temp.path().join(program)).unwrap();
        assert!(
            readback(&root, &VALIDATION, &receipt).is_err(),
            "a swapped-in link is refused"
        );
    }

    #[test]
    fn plain_directories_are_not_seedable_volumes() {
        let temp = volume();
        let error = open_volume(temp.path(), true).err().unwrap();
        assert!(error.0.contains("not a mount point"), "{error}");
    }
}
