use super::*;
use flate2::{write::GzEncoder, Compression};

struct TestSigner {
    scratch: tempfile::TempDir,
    public: String,
}

impl TestSigner {
    fn generate() -> Self {
        let scratch = tempfile::tempdir().unwrap();
        let key = scratch.path().join("key");
        assert!(Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(&key)
            .status()
            .unwrap()
            .success());
        let value = fs::read_to_string(key.with_extension("pub")).unwrap();
        let public = value
            .split_ascii_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        Self { scratch, public }
    }

    fn sign(&self, contents: &[u8]) -> Vec<u8> {
        let input = self.scratch.path().join("manifest");
        let signature = input.with_extension("sig");
        if signature.exists() {
            fs::remove_file(&signature).unwrap();
        }
        fs::write(&input, contents).unwrap();
        assert!(Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-Y", "sign", "-n", NAMESPACE, "-f"])
            .arg(self.scratch.path().join("key"))
            .arg(&input)
            .status()
            .unwrap()
            .success());
        fs::read(signature).unwrap()
    }
}

fn manifest(version: &str, payload: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "v": 1, "version": version,
        "artifacts": [{
            "arch": "x86_64",
            "locator": format!("openssh-{version}-linux-x86_64.tar.gz"),
            "sha256": format!("{:x}", Sha256::digest(payload))
        }]
    })
}

fn payload(extra: Option<(&str, tar::EntryType, u32, u64)>) -> Vec<u8> {
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::fast()));
    let mut header = tar::Header::new_ustar();
    header.set_mode(0o755);
    header.set_uid(0);
    header.set_gid(0);
    header.set_size(4);
    header.set_cksum();
    tar.append_data(&mut header, "usr/sbin/sshd", &b"test"[..])
        .unwrap();
    if let Some((path, kind, mode, uid)) = extra {
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_uid(uid);
        header.set_gid(0);
        header.set_size(0);
        // Raw fixture header permits hostile test paths that Builder refuses.
        header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
        header.set_cksum();
        tar.append(&header, io::empty()).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

#[test]
fn workspace_ssh_payload_verifies_signature_architecture_and_version() {
    let signer = TestSigner::generate();
    let other = TestSigner::generate();
    let mut manifest = manifest("9.6p1-terminalx.2", b"payload");
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let signature = signer.sign(&bytes);
    let verify = verify_with_key;
    assert!(verify(
        &bytes,
        &signature,
        Architecture::X86_64,
        Some(&Version::parse("9.6p1-terminalx.1").unwrap()),
        &signer.public
    )
    .is_ok());
    assert!(verify(
        &bytes,
        &signature,
        Architecture::Aarch64,
        None,
        &signer.public
    )
    .is_err());
    assert!(verify(
        &bytes,
        &signature,
        Architecture::X86_64,
        None,
        &other.public
    )
    .is_err());
    assert!(verify(&bytes, b"", Architecture::X86_64, None, &signer.public).is_err());
    assert!(verify(
        &bytes,
        &signature,
        Architecture::X86_64,
        Some(&Version::parse("9.6p1-terminalx.3").unwrap()),
        &signer.public
    )
    .is_err());

    manifest["artifacts"][0]["locator"] =
        serde_json::json!("https://example.invalid/openssh.tar.gz");
    let tampered = serde_json::to_vec(&manifest).unwrap();
    assert!(verify(
        &tampered,
        &signature,
        Architecture::X86_64,
        None,
        &signer.public
    )
    .is_err());
    assert!(verify(
        &tampered,
        &signer.sign(&tampered),
        Architecture::X86_64,
        None,
        &signer.public
    )
    .is_err());
    for version in ["9.6p0", "9.05p1", "9.6", "9.6p1-terminalx.0", "../9.6p1"] {
        assert!(Version::parse(version).is_err(), "{version}");
    }
    assert!(Version::parse("10.0p1").unwrap() > Version::parse("9.10p5").unwrap());
}

#[test]
fn workspace_ssh_payload_staging_verifies_before_unpack_and_preserves_current() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path();
    std::os::unix::fs::symlink("9.6p1", root_path.join("current")).unwrap();
    let guard = InstallLock::acquire(root_path).unwrap();
    let signer = TestSigner::generate();
    let bytes = payload(None);
    let raw = serde_json::to_vec(&manifest("9.7p1", &bytes)).unwrap();
    let verified = verify_with_key(
        &raw,
        &signer.sign(&raw),
        Architecture::X86_64,
        Some(&Version::parse("9.6p1").unwrap()),
        &signer.public,
    )
    .unwrap();
    assert!(guard.stage(&verified, b"mismatched").is_err());
    assert!(!root_path.join("9.7p1").exists());
    let version = guard.stage(&verified, &bytes).unwrap();
    let executable = version.join("usr/sbin/sshd");
    assert_eq!(fs::read(&executable).unwrap(), b"test");
    assert_eq!(fs::metadata(executable).unwrap().mode() & 0o777, 0o555);
    assert_eq!(
        fs::read_link(root_path.join("current")).unwrap(),
        Path::new("9.6p1")
    );
    assert!(guard.stage(&verified, &bytes).is_err());

    // The test process owns the directory and can restore permissions for cleanup.
    for path in [
        version.clone(),
        version.join("usr"),
        version.join("usr/sbin"),
    ] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

#[test]
fn workspace_ssh_payload_rejects_unsafe_archives_without_publishing_partial_versions() {
    let root = tempfile::tempdir().unwrap();
    let guard = InstallLock::acquire(root.path()).unwrap();
    let signer = TestSigner::generate();
    for extra in [
        ("../escape", tar::EntryType::Regular, 0o644, 0),
        ("/escape", tar::EntryType::Regular, 0o644, 0),
        ("usr/lib/link", tar::EntryType::Symlink, 0o644, 0),
        ("usr/lib/link", tar::EntryType::Link, 0o644, 0),
        ("usr/sbin/sshd", tar::EntryType::Regular, 0o644, 0),
        ("unsafe-mode", tar::EntryType::Regular, 0o4755, 0),
        ("wrong-owner", tar::EntryType::Regular, 0o644, 1000),
    ] {
        let bytes = payload(Some(extra));
        let raw = serde_json::to_vec(&manifest("9.7p1", &bytes)).unwrap();
        let verified = verify_with_key(
            &raw,
            &signer.sign(&raw),
            Architecture::X86_64,
            None,
            &signer.public,
        )
        .unwrap();
        assert!(guard.stage(&verified, &bytes).is_err(), "{extra:?}");
        assert!(!root.path().join("9.7p1").exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
