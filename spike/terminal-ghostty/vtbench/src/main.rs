use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use std::time::Instant;

struct Size { cols: usize, lines: usize }
impl Dimensions for Size {
    fn total_lines(&self) -> usize { self.lines }
    fn screen_lines(&self) -> usize { self.lines }
    fn columns(&self) -> usize { self.cols }
}

fn main() {
    for path in std::env::args().skip(1) {
        // As the PTY delivers it: \n becomes \r\n.
        let raw = std::fs::read(&path).unwrap();
        let mut bytes = Vec::with_capacity(raw.len() + raw.len() / 50);
        for b in raw { if b == b'\n' { bytes.push(b'\r'); } bytes.push(b); }
        let config = Config { scrolling_history: 10_000, ..Config::default() };
        let mut term = Term::new(config, &Size { cols: 190, lines: 24 }, VoidListener);
        let mut parser: Processor = Processor::new();
        let started = Instant::now();
        let mut damaged_lines = 0usize;
        let mut batches = 0usize;
        for chunk in bytes.chunks(32 * 1024) {
            parser.advance(&mut term, chunk);
            // What a damage-only frame would have to carry after each 32 KB batch.
            match term.damage() {
                alacritty_terminal::term::TermDamage::Full => damaged_lines += 24,
                alacritty_terminal::term::TermDamage::Partial(lines) => damaged_lines += lines.count(),
            }
            term.reset_damage();
            batches += 1;
        }
        let secs = started.elapsed().as_secs_f64();
        println!("{}: {:.1} MB in {:.3} s = {:.0} MB/s; {} history lines; mean {:.1} damaged lines per 32 KB batch",
            path.rsplit('/').next().unwrap(), bytes.len() as f64 / 1048576.0, secs, bytes.len() as f64 / 1048576.0 / secs,
            term.grid().history_size(), damaged_lines as f64 / batches as f64);
    }
}
