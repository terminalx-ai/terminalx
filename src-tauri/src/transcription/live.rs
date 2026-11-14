//! Live words from a local model (#754): microphone audio goes to a streaming
//! recogniser as it arrives, and the text it has so far comes back while the
//! reader is still speaking. Stop then only has to finish the stream (the
//! audio still buffered inside it) instead of starting over on the whole
//! recording.
//!
//! Whether a model streams is the model's own answer, read from the loaded
//! weights (`capabilities().supports_streaming`, see `engine.rs`), never a
//! list of names. A model that cannot stream, or a stream that will not
//! begin or breaks part way, leaves the recording to be transcribed whole
//! when the reader stops, as every local model did before.
//!
//! Everything here is independent of the recogniser behind [`LiveStream`],
//! so the reading, batching and fallback are tested against a stand-in.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;

use super::engine::TARGET_RATE;

/// Microphone callbacks deliver a few milliseconds of audio at a time, and a
/// feed is not free: a cache-aware model recomputes its features over its
/// sliding window on every call. So audio is gathered into pieces of about a
/// tenth of a second first. The streaming models here decode whole chunks of
/// 80 ms encoder frames, about a second's worth by default, so gathering a
/// tenth of a second adds no delay the reader can see.
pub const FEED_SAMPLES: usize = TARGET_RATE as usize / 10;

/// A recogniser that takes audio as it arrives.
pub trait LiveStream {
    /// Take more audio; answer with everything heard so far, the settled part
    /// first and the part still being revised after it.
    fn feed(&mut self, pcm: &[f32]) -> anyhow::Result<String>;
    /// No more audio is coming: decode what is still buffered and answer with
    /// the whole transcript.
    fn finalize(&mut self) -> anyhow::Result<String>;
}

/// How a dictation's words come to be final.
#[derive(Debug, PartialEq, Eq)]
pub enum Ending {
    /// The stream's own last word on everything it was fed.
    Streamed(String),
    /// There was no stream, or it broke (the reason); the recording is to be
    /// transcribed whole.
    Recorded(Option<String>),
}

/// Everything the microphone delivered, and how its words end.
#[derive(Debug)]
pub struct Heard {
    /// The whole recording, for the noise guard and for a transcription of
    /// the whole when nothing streamed.
    pub samples: Vec<f32>,
    pub ending: Ending,
}

/// Begin a stream for `id` when the model says it can stream. Answers `None`,
/// with the reason in the log, when the words will only come at the end.
pub fn begin<S>(id: &str, streams: bool, begin: impl FnOnce() -> Result<S, String>) -> Option<S> {
    if !streams {
        log::info!("dictation: {id} cannot stream, so its words appear when dictation stops");
        return None;
    }
    match begin() {
        Ok(stream) => Some(stream),
        Err(reason) => {
            log::warn!("dictation: live words from {id} could not start ({reason}); recording until stop and transcribing then instead");
            None
        }
    }
}

/// What came of handing the stream one more piece of audio.
enum Fed {
    Text(String),
    Broke(String),
}

fn feed(stream: &mut dyn LiveStream, pcm: &[f32]) -> Fed {
    match stream.feed(pcm) {
        Ok(text) => Fed::Text(text.trim().to_string()),
        Err(error) => Fed::Broke(format!("{error:#}")),
    }
}

/// Read `frames` until the microphone closes (the reader stopped), feeding
/// `stream` as the audio arrives and calling `partial` with the stream's text
/// whenever it changes. A stream that fails is dropped with `lost` told why;
/// the audio is still kept, so the recording can be transcribed whole.
///
/// `None` once `cancelled` is set: the dictation was abandoned and nothing
/// more is to be said about it.
pub fn listen(
    frames: Receiver<Vec<f32>>,
    mut stream: Option<&mut dyn LiveStream>,
    cancelled: &AtomicBool,
    mut partial: impl FnMut(&str),
    mut lost: impl FnMut(&str),
) -> Option<Heard> {
    let mut samples = Vec::new();
    let mut pending: Vec<f32> = Vec::new();
    let mut broke: Option<String> = None;
    let mut shown = String::new();
    let mut step = |stream: &mut Option<&mut dyn LiveStream>, pcm: &[f32], broke: &mut Option<String>| {
        let Some(live) = stream.as_deref_mut() else { return };
        match feed(live, pcm) {
            // Blank says nothing, and the composer ignores it anyway.
            Fed::Text(text) if !text.is_empty() && text != shown => {
                partial(&text);
                shown = text;
            }
            Fed::Text(_) => {}
            Fed::Broke(reason) => {
                lost(&reason);
                *broke = Some(reason);
                *stream = None;
            }
        }
    };
    while let Ok(chunk) = frames.recv() {
        if cancelled.load(Ordering::Relaxed) {
            return None;
        }
        pending.extend_from_slice(&chunk);
        // Whatever else is already waiting goes in the same feed. After a
        // model load, or a feed that ran long, the backlog is decoded at once
        // rather than a sliver at a time behind the speaker.
        while let Ok(more) = frames.try_recv() {
            pending.extend_from_slice(&more);
        }
        if pending.len() < FEED_SAMPLES {
            continue;
        }
        step(&mut stream, &pending, &mut broke);
        samples.append(&mut pending);
    }
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    if !pending.is_empty() {
        step(&mut stream, &pending, &mut broke);
        samples.append(&mut pending);
    }
    let ending = match stream {
        Some(live) => match live.finalize() {
            Ok(text) => Ending::Streamed(text.trim().to_string()),
            Err(error) => {
                let reason = format!("{error:#}");
                lost(&reason);
                Ending::Recorded(Some(reason))
            }
        },
        None => Ending::Recorded(broke),
    };
    if cancelled.load(Ordering::Relaxed) {
        return None;
    }
    Some(Heard { samples, ending })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    /// A model that hears one word per fifth of a second: what it says depends
    /// only on how much audio it has had, so a test knows what each feed
    /// should produce. The last word comes only from finalize, the way a
    /// streaming model holds its last chunk back.
    #[derive(Default)]
    struct Counting {
        fed: Arc<AtomicUsize>,
        broken: Arc<AtomicBool>,
        feeds: Vec<usize>,
        break_after: Option<usize>,
        refuse_finalize: bool,
        finalized: bool,
    }

    const WORD: usize = TARGET_RATE as usize / 5;

    fn words(n: usize) -> String {
        (0..n).map(|i| format!("w{i}")).collect::<Vec<_>>().join(" ")
    }

    impl Counting {
        /// Whether the model has had the first `sent` samples, or will never
        /// take more.
        fn caught_up(&self) -> impl Fn(usize) -> bool + Send + 'static {
            let (fed, broken) = (self.fed.clone(), self.broken.clone());
            move |sent| fed.load(Ordering::SeqCst) >= sent || broken.load(Ordering::SeqCst)
        }
    }

    impl LiveStream for Counting {
        fn feed(&mut self, pcm: &[f32]) -> anyhow::Result<String> {
            if self.break_after.is_some_and(|n| self.feeds.len() >= n) {
                self.broken.store(true, Ordering::SeqCst);
                anyhow::bail!("stream feed: the model gave up");
            }
            self.feeds.push(pcm.len());
            let fed = self.fed.fetch_add(pcm.len(), Ordering::SeqCst) + pcm.len();
            // Leading space, as a token stream's text often has.
            Ok(format!(" {}", words(fed / WORD)))
        }

        fn finalize(&mut self) -> anyhow::Result<String> {
            if self.refuse_finalize {
                anyhow::bail!("stream finalize: out of memory");
            }
            self.finalized = true;
            Ok(words(self.fed.load(Ordering::SeqCst).div_ceil(WORD)))
        }
    }

    /// The microphone: `seconds` of audio in ten-millisecond chunks. After
    /// each tenth of a second it waits until the model has had it, so what is
    /// fed when does not hang on how quickly the test's threads are
    /// scheduled. `stopped` is set just before the microphone closes, which
    /// is what the reader's Stop does.
    fn speak(seconds: f32, caught_up: impl Fn(usize) -> bool + Send + 'static, stopped: Arc<AtomicBool>) -> (Receiver<Vec<f32>>, JoinHandle<()>) {
        let (tx, rx) = mpsc::channel();
        let total = (seconds * TARGET_RATE as f32) as usize;
        let size = TARGET_RATE as usize / 100;
        let mic = std::thread::spawn(move || {
            let mut sent = 0;
            while sent < total {
                let n = size.min(total - sent);
                tx.send(vec![0.1; n]).unwrap();
                sent += n;
                if sent % FEED_SAMPLES == 0 {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while !caught_up(sent) {
                        assert!(Instant::now() < deadline, "the model took {sent} samples within 10 s");
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
            }
            stopped.store(true, Ordering::SeqCst);
        });
        (rx, mic)
    }

    #[test]
    fn partials_arrive_while_the_microphone_is_still_open() {
        let mut stream = Counting::default();
        let stopped = Arc::new(AtomicBool::new(false));
        let (frames, mic) = speak(2.0, stream.caught_up(), stopped.clone());
        let mut shown = Vec::new();
        let heard = listen(frames, Some(&mut stream), &AtomicBool::new(false), |text| {
            shown.push((text.to_string(), stopped.load(Ordering::SeqCst)));
        }, |reason| panic!("nothing broke: {reason}"))
        .unwrap();
        mic.join().unwrap();

        let all: Vec<_> = shown.iter().map(|(text, _)| text.clone()).collect();
        assert_eq!(all, (1..=10).map(words).collect::<Vec<_>>(), "each new word shown once, without the leading space");
        // The last one may race the microphone closing; every one before it
        // was shown while the reader was still speaking.
        let while_speaking = shown.iter().take_while(|(_, stopped)| !stopped).count();
        assert!(while_speaking >= 9, "{shown:?}");
        assert_eq!(heard.samples.len(), 2 * TARGET_RATE as usize);
        assert!(stream.finalized);
        assert_eq!(heard.ending, Ending::Streamed(words(10)));
    }

    #[test]
    fn the_final_text_carries_on_from_the_last_partial_without_repeating_it() {
        let mut stream = Counting::default();
        let (frames, mic) = speak(1.1, stream.caught_up(), Arc::default());
        let mut shown = Vec::new();
        let heard = listen(frames, Some(&mut stream), &AtomicBool::new(false), |text| shown.push(text.to_string()), |_| {}).unwrap();
        mic.join().unwrap();

        assert_eq!(shown.last().map(String::as_str), Some(words(5).as_str()));
        assert_eq!(heard.ending, Ending::Streamed(words(6)), "the held-back word added once, nothing before it again");
    }

    #[test]
    fn audio_is_fed_in_pieces_of_a_tenth_of_a_second_or_more_and_none_is_lost() {
        let (tx, rx) = mpsc::channel();
        for _ in 0..100 {
            tx.send(vec![0.1; 160]).unwrap();
        }
        tx.send(vec![0.1; 37]).unwrap();
        drop(tx);
        let mut stream = Counting::default();
        let heard = listen(rx, Some(&mut stream), &AtomicBool::new(false), |_| {}, |_| {}).unwrap();

        assert!(stream.feeds.iter().all(|n| *n >= FEED_SAMPLES), "{:?}", stream.feeds);
        assert_eq!(stream.fed.load(Ordering::SeqCst), TARGET_RATE as usize + 37);
        assert_eq!(heard.samples.len(), TARGET_RATE as usize + 37);
    }

    #[test]
    fn a_short_tail_after_the_last_full_piece_is_still_fed_before_the_end() {
        let mut stream = Counting::default();
        let (frames, mic) = speak(0.25, stream.caught_up(), Arc::default());
        let heard = listen(frames, Some(&mut stream), &AtomicBool::new(false), |_| {}, |_| {}).unwrap();
        mic.join().unwrap();
        assert_eq!(stream.feeds.iter().sum::<usize>(), TARGET_RATE as usize / 4);
        assert!(stream.feeds.last().is_some_and(|n| *n < FEED_SAMPLES), "{:?}", stream.feeds);
        assert_eq!(heard.ending, Ending::Streamed(words(2)));
    }

    #[test]
    fn unchanged_text_is_not_shown_twice() {
        let mut stream = Counting::default();
        // A word every fifth of a second, a feed every tenth: every other feed
        // repeats the text before it.
        let (frames, mic) = speak(1.0, stream.caught_up(), Arc::default());
        let mut shown = Vec::new();
        listen(frames, Some(&mut stream), &AtomicBool::new(false), |text| shown.push(text.to_string()), |_| {}).unwrap();
        mic.join().unwrap();
        assert!(stream.feeds.len() > shown.len(), "{} feeds, {shown:?}", stream.feeds.len());
        assert_eq!(shown, (1..=5).map(words).collect::<Vec<_>>());
    }

    #[test]
    fn a_stream_that_breaks_part_way_leaves_the_whole_recording_to_transcribe() {
        let mut stream = Counting { break_after: Some(3), ..Default::default() };
        let (frames, mic) = speak(1.0, stream.caught_up(), Arc::default());
        let mut shown = Vec::new();
        let mut lost = Vec::new();
        let heard = listen(frames, Some(&mut stream), &AtomicBool::new(false), |text| shown.push(text.to_string()), |reason| lost.push(reason.to_string())).unwrap();
        mic.join().unwrap();

        assert_eq!(shown, [words(1)], "live words until it broke");
        assert_eq!(lost, ["stream feed: the model gave up"]);
        assert!(!stream.finalized, "a broken stream is not finalized");
        assert_eq!(heard.samples.len(), TARGET_RATE as usize, "the audio after the break is kept too");
        assert_eq!(heard.ending, Ending::Recorded(Some("stream feed: the model gave up".into())));
    }

    #[test]
    fn a_stream_that_cannot_finish_leaves_the_whole_recording_to_transcribe() {
        let (tx, rx) = mpsc::channel();
        tx.send(vec![0.1; TARGET_RATE as usize]).unwrap();
        drop(tx);
        let mut stream = Counting { refuse_finalize: true, ..Default::default() };
        let mut lost = Vec::new();
        let heard = listen(rx, Some(&mut stream), &AtomicBool::new(false), |_| {}, |reason| lost.push(reason.to_string())).unwrap();
        assert_eq!(lost, ["stream finalize: out of memory"]);
        assert_eq!(heard.samples.len(), TARGET_RATE as usize);
        assert_eq!(heard.ending, Ending::Recorded(Some("stream finalize: out of memory".into())));
    }

    #[test]
    fn without_a_stream_the_recording_is_kept_whole_and_nothing_is_shown() {
        let (frames, mic) = speak(0.5, |_| true, Arc::default());
        let heard = listen(frames, None, &AtomicBool::new(false), |text| panic!("no live words: {text}"), |_| {}).unwrap();
        mic.join().unwrap();
        assert_eq!(heard.samples.len(), TARGET_RATE as usize / 2);
        assert_eq!(heard.ending, Ending::Recorded(None));
    }

    #[test]
    fn an_abandoned_dictation_says_nothing_more() {
        let (tx, rx) = mpsc::channel();
        tx.send(vec![0.1; TARGET_RATE as usize]).unwrap();
        drop(tx);
        let mut stream = Counting::default();
        let cancelled = AtomicBool::new(true);
        assert!(listen(rx, Some(&mut stream), &cancelled, |_| panic!("abandoned"), |_| {}).is_none());
        assert!(!stream.finalized);
    }

    #[test]
    fn a_model_that_cannot_stream_is_never_asked_to() {
        crate::test_log::capture();
        let started = begin::<Counting>("whisper-small", false, || panic!("not asked"));
        assert!(started.is_none());
        let line = crate::test_log::logged("whisper-small cannot stream");
        assert_eq!(line.len(), 1, "{line:?}");
        assert_eq!(line[0].0, log::Level::Info);
    }

    #[test]
    fn a_stream_that_will_not_begin_falls_back_to_recording_and_logs_why() {
        crate::test_log::capture();
        let mut started = begin::<Counting>("parakeet-unified-en-0.6b", true, || Err("a stream is already active on this model".into()));
        assert!(started.is_none());
        let line = crate::test_log::logged("live words from parakeet-unified-en-0.6b could not start");
        assert_eq!(line.len(), 1, "{line:?}");
        assert_eq!(line[0].0, log::Level::Warn);
        assert!(line[0].1.contains("a stream is already active on this model"), "{line:?}");

        // The dictation still hears everything, to transcribe at the end.
        let (frames, mic) = speak(1.0, |_| true, Arc::default());
        let heard = listen(frames, started.as_mut().map(|s| s as &mut dyn LiveStream), &AtomicBool::new(false), |text| panic!("no live words: {text}"), |_| {}).unwrap();
        mic.join().unwrap();
        assert_eq!(heard.samples.len(), TARGET_RATE as usize);
        assert_eq!(heard.ending, Ending::Recorded(None));
    }

    #[test]
    fn a_stream_that_begins_is_used() {
        assert!(begin("nemotron-3.5-asr-streaming-0.6b", true, || Ok(Counting::default())).is_some());
    }
}
