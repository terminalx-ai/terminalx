//! The microphone, as 16 kHz mono float frames. `cpal` opens the device the
//! reader picked (or the system default), and whatever rate and channel count
//! it delivers is folded down to what every recogniser here expects. Capture
//! runs on its own thread because the stream handle is not shared across
//! threads on every platform; the thread lives until told to stop.

use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::JoinHandle;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use super::engine::TARGET_RATE;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Input devices by name; cpal has no stable id, and names are what the
/// reader recognises anyway.
pub fn list_inputs() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if let Ok(name) = d.name() {
                let is_default = default_name.as_deref() == Some(name.as_str());
                out.push(InputDevice { id: name.clone(), name, is_default });
            }
        }
    }
    out
}

fn pick_device(name: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if d.name().map(|dn| dn == n).unwrap_or(false) {
                    return Ok(d);
                }
            }
        }
        // Fall through to the default rather than fail: the device may have
        // been unplugged since it was chosen.
    }
    host.default_input_device().ok_or_else(|| anyhow!("no microphone is available"))
}

/// Linear resampling with channel averaging. Speech tolerates it well and it
/// keeps the dependency list short.
pub struct Resampler {
    src_rate: f64,
    channels: usize,
    /// Fractional read position carried between calls, in source frames.
    pos: f64,
    /// The last source frame from the previous call, for interpolation across chunks.
    carry: Option<f32>,
}

impl Resampler {
    pub fn new(src_rate: u32, channels: u16) -> Self {
        Self { src_rate: src_rate as f64, channels: channels.max(1) as usize, pos: 0.0, carry: None }
    }

    pub fn push(&mut self, interleaved: &[f32]) -> Vec<f32> {
        let frames = interleaved.len() / self.channels;
        let mono: Vec<f32> = (0..frames)
            .map(|i| {
                let s = &interleaved[i * self.channels..(i + 1) * self.channels];
                s.iter().sum::<f32>() / self.channels as f32
            })
            .collect();
        if (self.src_rate - TARGET_RATE as f64).abs() < 1.0 {
            return mono;
        }
        let step = self.src_rate / TARGET_RATE as f64;
        let mut out = Vec::with_capacity((frames as f64 / step) as usize + 2);
        // Prepend the carried frame so interpolation at the seam is continuous.
        let mut src: Vec<f32> = Vec::with_capacity(mono.len() + 1);
        if let Some(c) = self.carry {
            src.push(c);
        }
        src.extend_from_slice(&mono);
        let mut pos = self.pos;
        while pos + 1.0 < src.len() as f64 {
            let i = pos as usize;
            let frac = (pos - i as f64) as f32;
            out.push(src[i] + (src[i + 1] - src[i]) * frac);
            pos += step;
        }
        // Keep the last frame and the position relative to it.
        let last = src.len().saturating_sub(1);
        self.carry = src.last().copied();
        self.pos = pos - last as f64;
        out
    }
}

pub struct Capture {
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    /// Open the device and stream 16 kHz mono chunks to `out` until dropped.
    pub fn start(device_name: Option<&str>, out: Sender<Vec<f32>>) -> Result<Capture> {
        let device = pick_device(device_name)?;
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
        let thread = std::thread::Builder::new()
            .name("mic-capture".into())
            .spawn(move || run(device, out, stop_rx, ready_tx))
            .context("capture thread")?;
        ready_rx.recv().context("capture thread ended early")??;
        Ok(Capture { stop: stop_tx, thread: Some(thread) })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(device: cpal::Device, out: Sender<Vec<f32>>, stop: Receiver<()>, ready: Sender<Result<()>>) {
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(anyhow!("microphone has no usable format: {e}")));
            return;
        }
    };
    let rate = config.sample_rate().0;
    let channels = config.channels();
    let format = config.sample_format();
    let stream_config: cpal::StreamConfig = config.into();
    let mut resampler = Resampler::new(rate, channels);
    let err_cb = |e: cpal::StreamError| log::warn!("microphone stream: {e}");
    let stream = match format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _| {
                let _ = out.send(resampler.push(data));
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &stream_config,
            move |data: &[i16], _| {
                let f: Vec<f32> = data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                let _ = out.send(resampler.push(&f));
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &stream_config,
            move |data: &[u16], _| {
                let f: Vec<f32> = data.iter().map(|s| (*s as f32 - 32768.0) / 32768.0).collect();
                let _ = out.send(resampler.push(&f));
            },
            err_cb,
            None,
        ),
        other => {
            let _ = ready.send(Err(anyhow!("unsupported microphone sample format {other:?}")));
            return;
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = ready.send(Err(anyhow!("could not open the microphone: {e}")));
            return;
        }
    };
    if let Err(e) = stream.play() {
        let _ = ready.send(Err(anyhow!("could not start the microphone: {e}")));
        return;
    }
    let _ = ready.send(Ok(()));
    let _ = stop.recv();
    drop(stream);
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
}
