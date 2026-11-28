//! The microphone, as 16 kHz mono float frames. `cpal` opens the device the
//! reader picked (or the system default), and whatever rate and channel count
//! it delivers is folded down to what every recogniser here expects. Capture
//! runs on its own thread because the stream handle is not shared across
//! threads on every platform; the thread lives until told to stop.
//!
//! Everything that talks to the audio backend — picking the device, reading
//! its format, opening the stream — happens on that thread. Enumerating audio
//! devices on macOS can block for a second or more while Bluetooth endpoints
//! are probed, and none of it belongs on the thread that services the
//! webview's IPC.

#[cfg(any(target_os = "macos", test))]
use std::cell::UnsafeCell;
#[cfg(any(target_os = "macos", test))]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(any(target_os = "macos", test))]
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, Receiver, Sender};
#[cfg(target_os = "macos")]
use std::thread::JoinHandle;
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(any(target_os = "macos", test))]
use anyhow::{anyhow, Result};
#[cfg(target_os = "macos")]
use anyhow::Context;
use cpal::traits::{DeviceTrait, HostTrait};
#[cfg(target_os = "macos")]
use cpal::traits::StreamTrait;
#[cfg(target_os = "macos")]
use cpal::{FromSample, SizedSample};
use serde::Serialize;

#[cfg(any(target_os = "macos", test))]
use super::engine::TARGET_RATE;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// The device's display name. cpal's own `id()` is stable across reboots but
/// opaque; the name is what the reader picked in Settings and what older
/// settings files already hold, so that is what is matched on.
fn device_name(device: &cpal::Device) -> Option<String> {
    let description = device.description().ok()?;
    // Windows' short description is "Microphone" for nearly every input; its
    // friendly name is what tells them apart.
    #[cfg(windows)]
    if let Some(friendly) = description.extended().first() {
        return Some(friendly.clone());
    }
    Some(description.name().to_string())
}

/// Input devices by name; the name is what the reader recognises and what
/// settings store.
///
/// Blocking: this walks every audio device the system knows about. Call it off
/// the main thread.
pub fn list_inputs() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().as_ref().and_then(device_name);
    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            let Some(name) = device_name(&d) else { continue };
            // A name is the id settings store: a second device of the same name
            // could not be told from the first, and capture opens the first.
            if out.iter().any(|known: &InputDevice| known.name == name) {
                continue;
            }
            let is_default = default_name.as_deref() == Some(name.as_str());
            out.push(InputDevice { id: name.clone(), name, is_default });
        }
    }
    out
}

#[cfg(any(target_os = "macos", test))]
fn pick_device(name: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if device_name(&d).as_deref() == Some(n) {
                    return Ok(d);
                }
            }
        }
        // Fall through to the default rather than fail: the device may have
        // been unplugged since it was chosen.
    }
    host.default_input_device().ok_or_else(|| anyhow!("no microphone is available"))
}

/// Lock-free single-producer single-consumer ring buffer for CoreAudio
/// real-time callbacks: zero heap allocations, zero locks, and zero syscalls
/// on the audio thread (P-35).
#[cfg(any(target_os = "macos", test))]
struct SpscRing {
    buf: Box<[UnsafeCell<f32>]>,
    mask: usize,
    channels: usize,
    write: AtomicUsize,
    read: AtomicUsize,
}

// SAFETY: Single producer owns slots in `[write, read + cap)` and single
// consumer owns slots in `[read, write)`, synchronized via Acquire/Release
// atomics on `write` and `read`.
#[cfg(any(target_os = "macos", test))]
unsafe impl Sync for SpscRing {}

#[cfg(any(target_os = "macos", test))]
struct RingProducer(Arc<SpscRing>);

#[cfg(any(target_os = "macos", test))]
struct RingConsumer(Arc<SpscRing>);

#[cfg(any(target_os = "macos", test))]
fn spsc_ring(capacity_pow2: usize, channels: u16) -> (RingProducer, RingConsumer) {
    debug_assert!(capacity_pow2.is_power_of_two() && capacity_pow2 >= 2);
    let mut storage = Vec::with_capacity(capacity_pow2);
    for _ in 0..capacity_pow2 {
        storage.push(UnsafeCell::new(0.0));
    }
    let ring = Arc::new(SpscRing {
        buf: storage.into_boxed_slice(),
        mask: capacity_pow2 - 1,
        channels: channels.max(1) as usize,
        write: AtomicUsize::new(0),
        read: AtomicUsize::new(0),
    });
    (RingProducer(Arc::clone(&ring)), RingConsumer(ring))
}

#[cfg(any(target_os = "macos", test))]
impl RingProducer {
    /// Push whole interleaved frames without allocating or blocking. Drops tail
    /// frames if the consumer falls behind.
    #[cfg(test)]
    fn push_f32(&self, data: &[f32]) {
        let mut w = self.0.write.load(Ordering::Relaxed);
        let r = self.0.read.load(Ordering::Acquire);
        let avail = self.0.buf.len().saturating_sub(w.wrapping_sub(r));
        let channels = self.0.channels;
        let count = (data.len().min(avail) / channels) * channels;
        for &sample in &data[..count] {
            let slot = w & self.0.mask;
            // SAFETY: Single producer owns slots in `[write, read + cap)`.
            unsafe {
                *self.0.buf[slot].get() = sample;
            }
            w = w.wrapping_add(1);
        }
        if count > 0 {
            self.0.write.store(w, Ordering::Release);
        }
    }

    #[cfg(target_os = "macos")]
    fn push_samples<T>(&self, data: &[T])
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let mut w = self.0.write.load(Ordering::Relaxed);
        let r = self.0.read.load(Ordering::Acquire);
        let avail = self.0.buf.len().saturating_sub(w.wrapping_sub(r));
        let channels = self.0.channels;
        let count = (data.len().min(avail) / channels) * channels;
        for sample in &data[..count] {
            let slot = w & self.0.mask;
            // SAFETY: Single producer owns slots in `[write, read + cap)`.
            unsafe {
                *self.0.buf[slot].get() = sample.to_sample::<f32>();
            }
            w = w.wrapping_add(1);
        }
        if count > 0 {
            self.0.write.store(w, Ordering::Release);
        }
    }
}

#[cfg(any(target_os = "macos", test))]
impl RingConsumer {
    fn drain_into(&self, out: &mut Vec<f32>) -> usize {
        let mut r = self.0.read.load(Ordering::Relaxed);
        let w = self.0.write.load(Ordering::Acquire);
        let count = w.wrapping_sub(r);
        if count == 0 {
            return 0;
        }
        out.reserve(count);
        for _ in 0..count {
            let slot = r & self.0.mask;
            // SAFETY: Single consumer owns slots in `[read, write)`.
            out.push(unsafe { *self.0.buf[slot].get() });
            r = r.wrapping_add(1);
        }
        self.0.read.store(r, Ordering::Release);
        count
    }
}

/// Linear resampling with channel averaging. Speech tolerates it well and it
/// keeps the dependency list short. Reuses internal scratch buffers across
/// calls so steady-state resampling does not churn heap allocations.
// macOS captures audio in production; all platforms run the resampling tests.
#[cfg(any(target_os = "macos", test))]
pub struct Resampler {
    src_rate: f64,
    channels: usize,
    /// Fractional read position carried between calls, in source frames.
    pos: f64,
    /// The last source frame from the previous call, for interpolation across chunks.
    carry: Option<f32>,
    mono_buf: Vec<f32>,
    src_buf: Vec<f32>,
}

#[cfg(any(target_os = "macos", test))]
impl Resampler {
    pub fn new(src_rate: u32, channels: u16) -> Self {
        Self {
            src_rate: src_rate as f64,
            channels: channels.max(1) as usize,
            pos: 0.0,
            carry: None,
            mono_buf: Vec::new(),
            src_buf: Vec::new(),
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) -> Vec<f32> {
        let frames = interleaved.len() / self.channels;
        self.mono_buf.clear();
        self.mono_buf.reserve(frames);
        let inv_channels = 1.0 / self.channels as f32;
        for chunk in interleaved.chunks_exact(self.channels) {
            self.mono_buf.push(chunk.iter().sum::<f32>() * inv_channels);
        }
        let step = self.src_rate / TARGET_RATE as f64;
        // A device that reports a nonsensical rate (zero, or a NaN out of a
        // half-initialised format) would otherwise spin here forever building
        // an unbounded output buffer. Hand the frames through untouched.
        if !step.is_finite() || step <= 0.0 || (self.src_rate - TARGET_RATE as f64).abs() < 1.0 {
            return self.mono_buf.clone();
        }
        let mut out = Vec::with_capacity((frames as f64 / step) as usize + 2);
        // Prepend the carried frame so interpolation at the seam is continuous.
        self.src_buf.clear();
        self.src_buf.reserve(self.mono_buf.len() + 1);
        if let Some(c) = self.carry {
            self.src_buf.push(c);
        }
        self.src_buf.extend_from_slice(&self.mono_buf);
        let mut pos = self.pos;
        while pos + 1.0 < self.src_buf.len() as f64 {
            let i = pos as usize;
            let frac = (pos - i as f64) as f32;
            out.push(self.src_buf[i] + (self.src_buf[i + 1] - self.src_buf[i]) * frac);
            pos += step;
        }
        // Keep the last frame and the position relative to it.
        let last = self.src_buf.len().saturating_sub(1);
        self.carry = self.src_buf.last().copied();
        self.pos = pos - last as f64;
        out
    }
}

/// A live microphone. Dropping it stops the stream and joins the thread.
// Only macOS dictation starts a microphone stream; enumeration remains portable.
#[cfg(target_os = "macos")]
pub struct Capture {
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

/// How opening the microphone went. `Ok` once frames are flowing, `Err` with a
/// message meant for the reader if the device could not be opened.
#[cfg(target_os = "macos")]
pub type Opening = Receiver<Result<(), String>>;

#[cfg(target_os = "macos")]
impl Capture {
    /// Open the device and stream 16 kHz mono chunks to `out` until dropped.
    ///
    /// Returns as soon as the capture thread exists: opening the device is the
    /// slow, permission-prompting part and it happens on that thread. Watch
    /// the returned channel for the outcome.
    pub fn start(device_name: Option<String>, out: Sender<Vec<f32>>) -> Result<(Capture, Opening)> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name("mic-capture".into())
            .spawn(move || run(device_name, out, stop_rx, ready_tx))
            .context("capture thread")?;
        Ok((Capture { stop: stop_tx, thread: Some(thread) }, ready_rx))
    }
}

#[cfg(target_os = "macos")]
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Build an input stream for one sample format, pushing converted `f32`
/// samples into the pre-allocated lock-free ring buffer with zero heap
/// allocations on CoreAudio's real-time callback thread (P-35).
#[cfg(target_os = "macos")]
fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    producer: RingProducer,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            producer.push_samples(data);
        },
        |e: cpal::StreamError| log::warn!("microphone stream: {e}"),
        None,
    )
}

/// Everything the capture thread does: pick the device, read its format, open
/// the stream, then drain the lock-free ring buffer and resample off the
/// real-time audio callback until told to stop. Every failure is reported
/// through `ready` as a sentence the reader can act on.
#[cfg(target_os = "macos")]
fn run(device_name: Option<String>, out: Sender<Vec<f32>>, stop: Receiver<()>, ready: Sender<Result<(), String>>) {
    macro_rules! fail {
        ($($arg:tt)*) => {{
            let _ = ready.send(Err(format!($($arg)*)));
            return;
        }};
    }

    let device = match pick_device(device_name.as_deref()) {
        Ok(d) => d,
        Err(e) => fail!("{e:#}"),
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        // This is also what a denied microphone permission looks like: the
        // device is listed but its format cannot be read.
        Err(e) => fail!("The microphone could not be opened ({e}). Check that TerminalX is allowed to use it under System Settings → Privacy & Security → Microphone."),
    };
    let rate = config.sample_rate();
    let channels = config.channels();
    let format = config.sample_format();
    if rate == 0 || channels == 0 {
        fail!("The microphone reported an unusable format ({rate} Hz, {channels} channels). Pick a different input under Settings → Transcription.");
    }
    let stream_config: cpal::StreamConfig = config.into();
    let mut resampler = Resampler::new(rate, channels);
    // 131,072 samples (~1.36s at 48 kHz stereo): pre-allocated once off the audio thread.
    let (producer, consumer) = spsc_ring(1 << 17, channels);

    use cpal::SampleFormat as F;
    let stream = match format {
        F::F32 => build_stream::<f32>(&device, &stream_config, producer),
        F::F64 => build_stream::<f64>(&device, &stream_config, producer),
        F::I8 => build_stream::<i8>(&device, &stream_config, producer),
        F::I16 => build_stream::<i16>(&device, &stream_config, producer),
        F::I32 => build_stream::<i32>(&device, &stream_config, producer),
        F::I64 => build_stream::<i64>(&device, &stream_config, producer),
        F::U8 => build_stream::<u8>(&device, &stream_config, producer),
        F::U16 => build_stream::<u16>(&device, &stream_config, producer),
        F::U32 => build_stream::<u32>(&device, &stream_config, producer),
        F::U64 => build_stream::<u64>(&device, &stream_config, producer),
        other => fail!("The microphone uses a sample format TerminalX cannot read ({other}). Pick a different input under Settings → Transcription."),
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => fail!("The microphone could not be opened ({e}). Check that TerminalX is allowed to use it under System Settings → Privacy & Security → Microphone."),
    };
    if let Err(e) = stream.play() {
        fail!("The microphone would not start ({e}).");
    }
    let _ = ready.send(Ok(()));
    let mut scratch = Vec::with_capacity(4096);
    loop {
        let stopping = match stop.recv_timeout(Duration::from_millis(10)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => true,
            Err(mpsc::RecvTimeoutError::Timeout) => false,
        };
        if stopping {
            drop(stream);
            scratch.clear();
            if consumer.drain_into(&mut scratch) > 0 {
                let resampled = resampler.push(&scratch);
                if !resampled.is_empty() {
                    let _ = out.send(resampled);
                }
            }
            break;
        }
        scratch.clear();
        if consumer.drain_into(&mut scratch) > 0 {
            let resampled = resampler.push(&scratch);
            if !resampled.is_empty() && out.send(resampled).is_err() {
                drop(stream);
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_halves_48k_stereo_to_16k_mono() {
        let mut r = Resampler::new(48_000, 2);
        let frames = 4800;
        let input: Vec<f32> = (0..frames).flat_map(|i| [i as f32, i as f32]).collect();
        let out = r.push(&input);
        // 4800 source frames become ~1600, minus one at the edge.
        assert!((1598..=1600).contains(&out.len()), "got {}", out.len());
        // Values climb monotonically at three source frames per output frame.
        assert!((out[10] - 30.0).abs() < 0.01);
    }

    #[test]
    fn resampler_passes_16k_mono_through() {
        let mut r = Resampler::new(16_000, 1);
        let out = r.push(&[0.1, 0.2, 0.3]);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    /// A device that reports nothing usable must not divide by zero, index out
    /// of bounds, or loop forever growing the output buffer.
    #[test]
    fn resampler_survives_a_degenerate_config() {
        let mut zero = Resampler::new(0, 0);
        assert!(zero.push(&[]).is_empty());
        // Zero source rate: pass the frames through rather than spin.
        assert_eq!(zero.push(&[0.5, -0.5]), vec![0.5, -0.5]);

        let mut empty = Resampler::new(48_000, 2);
        assert!(empty.push(&[]).is_empty());
        // A partial frame at the end of a chunk is dropped, not read past.
        assert_eq!(empty.push(&[1.0]).len(), 0);
    }

    #[test]
    fn spsc_ring_preserves_frame_alignment_across_wraparound_and_overflow() {
        let (producer, consumer) = spsc_ring(8, 2);
        // Push 3 stereo frames (6 samples), drain 2 frames (4 samples) -> wraps on next push.
        producer.push_f32(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
        let mut out = Vec::new();
        assert_eq!(consumer.drain_into(&mut out), 6);
        assert_eq!(out, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);

        // Overflow drops excess whole frames, keeping stereo alignment intact.
        producer.push_f32(&[10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0]);
        out.clear();
        assert_eq!(consumer.drain_into(&mut out), 8);
        assert_eq!(out, vec![10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0]);
    }

    /// Walks the same CoreAudio property calls the mic button walks. A release
    /// build of cpal 0.16 segfaulted here (see the notes on the cpal 0.17
    /// upgrade); run this with `--release` to exercise that path.
    ///
    /// Passes on a machine with no input device: it only asserts that whatever
    /// comes back is coherent.
    #[test]
    fn enumerates_inputs_and_reads_the_default_config() {
        let inputs = list_inputs();
        assert!(inputs.iter().filter(|d| d.is_default).count() <= 1, "more than one default input");
        for d in &inputs {
            assert!(!d.name.is_empty(), "input device with no name");
            assert_eq!(d.id, d.name);
        }

        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            return; // No microphone on this machine; nothing more to check.
        };
        assert!(pick_device(None).is_ok());
        // A name that matches nothing must fall back to the default, not fail.
        assert!(pick_device(Some("no such microphone")).is_ok());
        if let Some(name) = device_name(&device) {
            assert!(pick_device(Some(&name)).is_ok());
        }

        // Reading the format must not start a stream, and must not panic when
        // the device refuses (an unauthorised microphone reports an error).
        if let Ok(config) = device.default_input_config() {
            assert!(config.sample_rate() > 0, "default input config has no sample rate");
            assert!(config.channels() > 0, "default input config has no channels");
        }
    }
}
