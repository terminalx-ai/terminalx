//! What the code under test logged at info and above. `log` takes one logger
//! per process, and every test in this binary shares the process, so every
//! test that checks a log line reads it from here rather than installing its
//! own.

use std::sync::{Mutex, OnceLock};

struct Captured(Mutex<Vec<(log::Level, String)>>);

impl log::Log for Captured {
    fn enabled(&self, metadata: &log::Metadata) -> bool { metadata.level() <= log::Level::Info }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            self.0.lock().unwrap().push((record.level(), record.args().to_string()));
        }
    }
    fn flush(&self) {}
}

fn captured() -> &'static Captured {
    static CAPTURED: OnceLock<&'static Captured> = OnceLock::new();
    CAPTURED.get_or_init(|| {
        let captured: &'static Captured = Box::leak(Box::new(Captured(Mutex::default())));
        log::set_logger(captured).expect("nothing else in this test binary installs a logger");
        log::set_max_level(log::LevelFilter::Info);
        captured
    })
}

/// Start capturing, for a test whose log lines come from another thread
/// before it first asks what was logged.
pub fn capture() {
    captured();
}

/// The lines logged so far that contain `text`.
pub fn logged(text: &str) -> Vec<(log::Level, String)> {
    captured().0.lock().unwrap().iter().filter(|(_, line)| line.contains(text)).cloned().collect()
}
