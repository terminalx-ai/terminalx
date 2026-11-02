use std::{env, fs, time::Instant};
fn main() {
    println!("path\tframes\tvoice_frames\tmax_score\tmean_score\telapsed_us");
    for path in env::args().skip(1) {
        let bytes = fs::read(&path).unwrap();
        assert!(!bytes.is_empty() && bytes.len() % 4 == 0);
        let pcm: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect();
        assert!(pcm.iter().all(|x| x.is_finite() && x.abs() <= 1.));
        let start = Instant::now();
        let mut detector = earshot::Detector::default();
        let (mut frames, mut speech) = (0, 0);
        let (mut max, mut sum) = (0f32, 0f32);
        for part in pcm.chunks(256) {
            let mut frame = [0f32; 256];
            frame[..part.len()].copy_from_slice(part);
            let p = detector.predict_f32(&frame);
            assert!(p.is_finite() && (0.0..=1.0).contains(&p));
            frames += 1;
            speech += usize::from(p > 0.5);
            max = max.max(p);
            sum += p;
        }
        println!(
            "{}\t{}\t{}\t{}\t{}\t{}",
            path,
            frames,
            speech,
            max,
            sum / frames as f32,
            start.elapsed().as_micros()
        );
    }
}
