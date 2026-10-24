// Test-only replay of Tauri CLI 2.11.4 create_tar_from_src and updater 2.11.0 extraction.
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};
fn create_tar_from_src<P: AsRef<Path>, W: Write>(src_dir: P, dest_file: W) -> std::io::Result<W> {
    let src_dir = src_dir.as_ref();
    let mut builder = tar::Builder::new(dest_file);
    builder.follow_symlinks(false);
    builder.append_dir_all(src_dir.file_name().expect("Path has no file_name"), src_dir)?;
    builder.into_inner()
}
fn main() -> std::io::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let src = Path::new(&args[1]);
    let dest = Path::new(&args[2]);
    let extracted = Path::new(&args[3]);
    assert!(!dest.exists() && !extracted.exists());
    fs::create_dir(extracted)?;
    let gzip = GzEncoder::new(File::create(dest)?, Compression::default());
    let gzip = create_tar_from_src(src, gzip)?;
    let mut file = gzip.finish()?;
    file.flush()?;
    let decoder = GzDecoder::new(File::open(dest)?);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path: std::path::PathBuf = entry.path()?.iter().skip(1).collect();
        let to = extracted.join(path);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&to)?;
    }
    println!("normal create_tar_from_src + updater entry.unpack completed");
    Ok(())
}
