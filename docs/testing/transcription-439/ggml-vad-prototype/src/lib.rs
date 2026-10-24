//! Static detector adapter using the application's existing public GGML API.
//! Prototype: callers must preserve ASR output on any error, never call it silence.
use sha2::{Digest, Sha256};
use std::{ffi::c_void, marker::PhantomData, ptr::NonNull};
// Retain the dependency's native links; build.rs uses its public header metadata.
use transcribe_cpp as _;

pub const MODEL_SIZE: usize = 1_241_056;
pub const MODEL_SHA256: &str = "0d871a800c420fdd5d1b17a3aea4296d1c39608f0ff4a9295eb76457eb1c88e6";
const MAX_SAMPLES: usize = 16_000 * 300;

extern "C" {
    fn tx_vad_open(bytes: *const c_void, size: usize, out: *mut *mut c_void) -> i32;
    fn tx_vad_close(handle: *mut c_void);
    fn tx_vad_score(
        handle: *mut c_void,
        audio: *const f32,
        samples: usize,
        probabilities: *mut f32,
        capacity: usize,
    ) -> i32;
}

/// Owns an opaque CPU detector. Mutable access serializes runs. Not Sync.
pub struct Detector {
    handle: NonNull<c_void>,
    _not_sync: PhantomData<std::cell::Cell<()>>,
}
// SAFETY: native resources are exclusively owned, have no thread affinity, and
// every computation requires &mut self. No global session/context is shared.
unsafe impl Send for Detector {}

impl Detector {
    /// Check the exact pinned bytes before entering the native GGUF parser.
    /// The parser copies weights before return, so no path/TOCTOU race exists.
    pub fn from_verified_bytes(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != MODEL_SIZE || format!("{:x}", Sha256::digest(bytes)) != MODEL_SHA256 {
            return Err("detector model checksum mismatch");
        }
        let mut raw = std::ptr::null_mut();
        // SAFETY: bytes and output slot live through the call; native code
        // validates shape and owns its copied weights on success.
        let status = unsafe { tx_vad_open(bytes.as_ptr().cast(), bytes.len(), &mut raw) };
        if status != 0 {
            return Err("detector model load failed");
        }
        let handle = NonNull::new(raw).ok_or("detector returned no handle")?;
        Ok(Self {
            handle,
            _not_sync: PhantomData,
        })
    }

    /// Return every frame probability. Peak normalization affects only a copy;
    /// ASR must still receive the original samples. An error is unknown speech.
    pub fn probabilities(
        &mut self,
        audio: &[f32],
        normalize: bool,
    ) -> Result<Vec<f32>, &'static str> {
        if audio.is_empty()
            || audio.len() > MAX_SAMPLES
            || audio.iter().any(|s| !s.is_finite() || s.abs() > 1.0)
        {
            return Err("invalid detector audio");
        }
        let peak = audio.iter().fold(0.0_f32, |peak, s| peak.max(s.abs()));
        let normalized;
        let samples = if normalize && peak > 0.0 {
            normalized = audio.iter().map(|s| s / peak).collect::<Vec<_>>();
            &normalized[..]
        } else {
            audio
        };
        let mut probabilities = vec![f32::NAN; samples.len().div_ceil(512)];
        // SAFETY: valid exclusive handle, bounded finite input, and an allocated
        // writable output exactly matching ceil(samples/512). No pointer retained.
        let status = unsafe {
            tx_vad_score(
                self.handle.as_ptr(),
                samples.as_ptr(),
                samples.len(),
                probabilities.as_mut_ptr(),
                probabilities.len(),
            )
        };
        if status != 0
            || probabilities
                .iter()
                .any(|p| !p.is_finite() || !(0.0..=1.0).contains(p))
        {
            return Err("detector computation failed or incomplete");
        }
        Ok(probabilities)
    }
}
impl Drop for Detector {
    fn drop(&mut self) {
        // SAFETY: this is the unique owning handle, closed exactly once.
        unsafe { tx_vad_close(self.handle.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_model_never_enters_native_parser() {
        assert!(Detector::from_verified_bytes(&[]).is_err());
        assert!(Detector::from_verified_bytes(&vec![0; MODEL_SIZE]).is_err());
        let mut fake = vec![0; MODEL_SIZE];
        fake[..4].copy_from_slice(b"GGUF");
        assert!(Detector::from_verified_bytes(&fake).is_err());
    }
    #[test]
    #[ignore = "requires the explicit public checksum-pinned detector fixture"]
    fn real_model_reset_normalization_and_boundaries() {
        let path = std::env::var_os("TX439_VAD_MODEL").expect("explicit fixture path required");
        let bytes = std::fs::read(path).unwrap();
        let mut detector = Detector::from_verified_bytes(&bytes).unwrap();
        for n in [1_usize, 511, 512, 513, 256 * 512 + 1, 260 * 512 + 1] {
            let audio: Vec<_> = (0..n).map(|i| (i as f32 * 0.087).sin() * 0.0001).collect();
            let original = audio.clone();
            let a = detector.probabilities(&audio, true).unwrap();
            detector.probabilities(&[0.0; 512], false).unwrap();
            assert_eq!(a, detector.probabilities(&audio, true).unwrap());
            assert_eq!(a.len(), n.div_ceil(512));
            assert_eq!(audio, original);
        }
        for bad in [f32::NAN, f32::INFINITY, -f32::INFINITY, 1.01, -1.01] {
            assert!(detector.probabilities(&[bad], true).is_err());
        }
        assert!(detector.probabilities(&[], true).is_err());
    }
}
