use super::super::macos_delivery::tests::Delivery;
use super::*;
use std::path::PathBuf;
struct Fixture {
    delivery: Delivery,
    specs: Vec<Spec>,
    payload: Vec<u8>,
    applications: PathBuf,
    tar: PathBuf,
    codesign: PathBuf,
    ditto: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let delivery = Delivery::new();
        delivery.uploaded();
        delivery.guest("install").unwrap();
        let root = delivery.home.path();
        let applications = root.join("Applications");
        journal::private_directory(&applications).unwrap();
        let defs = [
            (
                "cua-driver",
                b"driver fixture archive".to_vec(),
                "CuaDriver.app/Contents/MacOS/cua-driver",
                "CuaDriver.app",
                b"synthetic driver".to_vec(),
            ),
            (
                "codex",
                b"codex fixture archive".to_vec(),
                "codex",
                "codex",
                b"synthetic provider".to_vec(),
            ),
        ];
        let mut specs = Vec::new();
        let mut payload = Vec::new();
        for (name, archive, exe, signed, binary) in defs {
            specs.push(Spec {
                name: name.into(),
                version: "fixture".into(),
                sha256: journal::digest(&archive),
                bytes: archive.len() as u64,
                executable: exe.into(),
                executable_sha256: journal::digest(&binary),
                signed_path: signed.into(),
                requirement: "=fixture-publisher-only".into(),
            });
            payload.extend(archive);
        }
        let tar = root.join("fake-tar");
        let codesign = root.join("fake-codesign");
        let ditto = root.join("fake-ditto");
        for (path, script) in [
            (
                &tar,
                r#"#!/usr/bin/python3
import pathlib,sys
root=pathlib.Path(__file__).parent;a=sys.argv[1:];assert a[0]=='-xzf' and a[2]=='-C'
with (root/'extract-count').open('a') as f:f.write('extract\n')
p=pathlib.Path(a[3]);driver=pathlib.Path(a[1]).name=='cua-driver.tar.gz'
exe=p/('CuaDriver.app/Contents/MacOS/cua-driver' if driver else 'codex');exe.parent.mkdir(parents=True,exist_ok=True);exe.write_bytes(b'synthetic driver' if driver else b'synthetic provider')
exe.chmod(0o700)
"#,
            ),
            (
                &codesign,
                r#"#!/usr/bin/python3
import pathlib,sys
root=pathlib.Path(__file__).parent;a=sys.argv[1:]
assert a[:2] in [['--verify','--strict'],['--verify','-R']]
if '-R' in a:assert a[2]=='=fixture-publisher-only'
assert pathlib.Path(a[-1]).exists()
if (root/'reject-signature').exists():sys.exit(74)
"#,
            ),
            (
                &ditto,
                r#"#!/usr/bin/python3
import pathlib,sys,shutil
assert len(sys.argv)==3
assert pathlib.Path(sys.argv[2]).is_dir()
shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)
"#,
            ),
        ] {
            std::fs::write(path, script).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            delivery,
            specs,
            payload,
            applications,
            tar,
            codesign,
            ditto,
        }
    }
    fn call(&self, action: &str, payload: &[u8]) -> Result<Value> {
        install_using(
            self.delivery.home.path(),
            &self.applications,
            &self.delivery.dir(),
            &self.delivery.intent,
            &self.specs,
            action,
            &mut std::io::Cursor::new(payload),
            &Programs {
                tar: &self.tar,
                codesign: &self.codesign,
                ditto: &self.ditto,
            },
        )
    }
}
#[test]
fn actual_tool_installer_checks_archives_signatures_and_recovers_original_receipt_without_activation(
) {
    let f = Fixture::new();
    let installed = f.call("toolsInstall", &f.payload).unwrap();
    assert_eq!(installed["stage"], "toolsInstalled");
    assert_eq!(installed["ready"], false);
    let recovered = f.call("toolsReceipt", b"").unwrap();
    assert_eq!(installed, recovered);
    f.call("toolsInstall", &f.payload).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.delivery.home.path().join("extract-count")).unwrap(),
        "extract\nextract\n"
    );
    assert!(!f
        .delivery
        .home
        .path()
        .join(".terminalx-local/runtime/run")
        .exists());
    assert!(!f.delivery.home.path().join(".codex").exists());
    std::fs::write(
        f.delivery.home.path().join(".terminalx-local/bin/codex"),
        b"replaced provider",
    )
    .unwrap();
    assert!(f.call("toolsReceipt", b"").is_err());
}
#[test]
fn changed_archive_or_publisher_and_partial_delivery_never_install_or_replay() {
    for fault in ["digest", "partial", "signature"] {
        let f = Fixture::new();
        let mut payload = f.payload.clone();
        match fault {
            "digest" => payload[0] ^= 1,
            "partial" => payload.truncate(2),
            _ => {
                std::fs::write(f.delivery.home.path().join("reject-signature"), b"fixture").unwrap()
            }
        }
        assert!(f.call("toolsInstall", &payload).is_err());
        assert!(f.call("toolsReceipt", b"").is_err());
        assert!(f.call("toolsInstall", &f.payload).is_err());
        assert!(!f.applications.join("CuaDriver.app").exists());
        assert!(!f
            .delivery
            .home
            .path()
            .join(".terminalx-local/bin/codex")
            .exists());
    }
}
#[test]
fn existing_tools_or_serving_owner_are_not_replaced() {
    for owner in [false, true] {
        let f = Fixture::new();
        if owner {
            journal::private_directory(
                &f.delivery.home.path().join(".terminalx-local/runtime/run"),
            )
            .unwrap();
        } else {
            std::fs::write(
                f.delivery.home.path().join(".terminalx-local/bin/codex"),
                b"existing provider",
            )
            .unwrap();
        }
        assert!(f.call("toolsInstall", &f.payload).is_err());
        assert!(!f.applications.join("CuaDriver.app").exists());
        assert!(!f.delivery.home.path().join("extract-count").exists());
    }
}

#[test]
fn original_tool_receipt_rejects_writable_or_aliased_executables() {
    for fault in ["permissions", "hardlink", "symlink"] {
        let f = Fixture::new();
        f.call("toolsInstall", &f.payload).unwrap();
        let executable = f.delivery.home.path().join(".terminalx-local/bin/codex");
        let alias = f.delivery.home.path().join("alias");
        match fault {
            "permissions" => {
                std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o777))
                    .unwrap()
            }
            "hardlink" => std::fs::hard_link(&executable, &alias).unwrap(),
            _ => {
                std::fs::rename(&executable, &alias).unwrap();
                std::os::unix::fs::symlink(&alias, &executable).unwrap();
            }
        }
        assert!(f.call("toolsReceipt", b"").is_err());
        assert!(f.call("toolsInstall", &f.payload).is_err());
        assert_eq!(
            std::fs::read_to_string(f.delivery.home.path().join("extract-count")).unwrap(),
            "extract\nextract\n"
        );
    }
}
