//! Dictation: the microphone into text, out as events. The microphone is
//! read through `cpal` (so the reader can pick a device) and its 16 kHz mono
//! frames go to whichever engine is selected: Apple's speech recogniser,
//! on-device where it can be, with partial results as they arrive; or a
//! local model from the catalog, transcribed in one go when the reader stops.
//!
//! Apple's objects are created and torn down on the main thread; the frame
//! pump feeds the recogniser from its own thread, which the framework allows.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationEvent {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Every event, into the log before it goes out. Dictation goes wrong in the
/// field — a recogniser that stops sending, a segment in a shape nobody
/// expected — and the only way to tell that from a composer that mishandled it
/// is a record of what was actually emitted. Run the binary with `RUST_LOG=debug`
/// to see it, next to the webview's own line for the same event.
fn trace(kind: &str, text: Option<&str>, message: Option<&str>) {
    let detail = match (text, message) {
        (Some(t), _) => {
            let head: String = t.chars().take(40).collect();
            let more = if t.chars().count() > 40 { "…" } else { "" };
            format!(" len={} {:?}", t.chars().count(), format!("{head}{more}"))
        }
        (None, Some(m)) => format!(" {m}"),
        (None, None) => String::new(),
    };
    log::debug!("dictation emit {kind}{detail}");
}

fn emit(app: &AppHandle, kind: &'static str, text: Option<String>, message: Option<String>) {
    trace(kind, text.as_deref(), message.as_deref());
    let _ = app.emit("dictation", DictationEvent { kind, text, message });
}

/// System output volume, read and written through AppleScript. Best effort:
/// a failure here must never stop a dictation.
#[cfg(target_os = "macos")]
mod volume {
    use std::process::Command;

    pub fn get() -> Option<u8> {
        let out = Command::new("osascript").args(["-e", "output volume of (get volume settings)"]).output().ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }

    pub fn set(level: u8) {
        let _ = Command::new("osascript").args(["-e", &format!("set volume output volume {level}")]).output();
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use crate::transcription::{audio, engine::TARGET_RATE, Transcription, APPLE};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AllocAnyThread;
    use objc2_avf_audio::{AVAudioFormat, AVAudioPCMBuffer};
    use objc2_foundation::NSError;
    use objc2_speech::{SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;

    /// Shown when the microphone was open but delivered nothing: no frames at
    /// all, or nothing but zeroes. That is what an unpermitted or muted input
    /// looks like from here, and it must never pass as a successful dictation.
    const NO_AUDIO: &str = "The microphone delivered no audio. Check the input under Settings → Transcription and that Raccoon is allowed to use the microphone.";
    /// Shown when a local model heard real sound and still made no words of it.
    const NOT_RECOGNISED: &str = "Nothing was recognised. Try again, speak closer to the microphone, or pick another model under Settings → Transcription.";
    /// Shown when macOS will not let this app near the microphone at all.
    const MIC_DENIED: &str = "Raccoon is not allowed to use the microphone. Enable it under System Settings → Privacy & Security → Microphone.";

    /// Whether a captured buffer is worth handing to an engine. Anything under
    /// a quarter second cannot hold a word, and a buffer of exact zeroes is
    /// what a microphone the app may not open delivers.
    fn is_silent(samples: &[f32]) -> bool {
        samples.len() < TARGET_RATE as usize / 4 || samples.iter().all(|s| *s == 0.0)
    }

    /// Microphone permission, as macOS sees it. Asking before opening the
    /// device matters under the hardened runtime: without the audio-input
    /// entitlement no prompt is ever raised and CoreAudio simply hands back
    /// silence, so a refusal has to be recognised rather than recorded.
    mod permission {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio};

        pub enum Mic {
            Granted,
            Denied,
            /// Never asked; a prompt will be raised.
            Ask,
        }

        /// The audio media type constant, or `None` if AVFoundation did not
        /// load — in which case there is nothing to ask and nothing to refuse.
        fn audio() -> Option<&'static AVMediaType> {
            unsafe { AVMediaTypeAudio }
        }

        pub fn status() -> Mic {
            let Some(media) = audio() else { return Mic::Granted };
            let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
            if status == AVAuthorizationStatus::Authorized {
                Mic::Granted
            } else if status == AVAuthorizationStatus::NotDetermined {
                Mic::Ask
            } else {
                Mic::Denied
            }
        }

        /// Raise the system prompt. `then` runs on an arbitrary thread once
        /// the reader has answered.
        pub fn request(then: impl Fn(bool) + 'static) {
            let Some(media) = audio() else {
                then(true);
                return;
            };
            let block = RcBlock::new(move |granted: Bool| then(granted.as_bool()));
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &block) };
        }
    }

    /// A recogniser request handed to the pump thread. The framework accepts
    /// buffers from any thread; only creation and teardown stay on main.
    struct RequestHandle(Retained<SFSpeechAudioBufferRecognitionRequest>);
    unsafe impl Send for RequestHandle {}

    enum Route {
        Apple {
            request: Retained<SFSpeechAudioBufferRecognitionRequest>,
            task: Retained<SFSpeechRecognitionTask>,
            _recognizer: Retained<SFSpeechRecognizer>,
            _handler: RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)>,
        },
        Local {
            id: String,
            path: PathBuf,
            audio: Arc<Mutex<Vec<f32>>>,
        },
    }

    /// The microphone, its frame stream, how opening it went, and the volume
    /// to put back afterwards.
    struct Opened {
        capture: audio::Capture,
        frames: Receiver<Vec<f32>>,
        opening: audio::Opening,
        restore_volume: Option<u8>,
    }

    pub struct Active {
        capture: Option<audio::Capture>,
        route: Route,
        restore_volume: Option<u8>,
    }
    // Apple's handles are only touched on the main thread; the mutex in
    // `Dictation` just moves the bundle between commands.
    unsafe impl Send for Active {}

    #[derive(Default)]
    pub struct Dictation {
        active: Mutex<Option<Active>>,
        /// Bumped per start; a result handler from an older run is ignored.
        generation: Arc<AtomicU64>,
        stopping: Arc<AtomicBool>,
        /// Set once the capture delivers a sample that is not exactly zero.
        /// The Apple route has no buffer to inspect afterwards, so the pump
        /// answers the same question the local route asks of its samples.
        heard: Arc<AtomicBool>,
        /// Set once the recogniser hands back a transcript with words in it.
        produced: Arc<AtomicBool>,
    }

    /// Whether the running binary declares a privacy usage string. Read from
    /// the main bundle so the answer matches what TCC will check.
    fn usage_string_present(key: &str) -> bool {
        let bundle = objc2_foundation::NSBundle::mainBundle();
        bundle.objectForInfoDictionaryKey(&objc2_foundation::NSString::from_str(key)).is_some()
    }

    impl Dictation {
        pub fn available() -> bool {
            true
        }

        pub fn is_active(&self) -> bool {
            self.active.lock().unwrap().is_some()
        }

        pub fn start(self: &Arc<Self>, app: AppHandle, transcription: Arc<Transcription>) -> Result<(), String> {
            if self.is_active() {
                return Ok(());
            }
            let model = transcription.effective_model();
            // macOS terminates a process that asks for the microphone or speech
            // without the matching usage string in its Info.plist. A binary can
            // lack them (a dev build made before the plist was picked up), so
            // refuse here with a message rather than let the OS kill the app.
            let needed: &[&str] = if model == APPLE { &["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"] } else { &["NSMicrophoneUsageDescription"] };
            if let Some(missing) = needed.iter().find(|k| !usage_string_present(k)) {
                let msg = format!("This build has no {missing} in its Info.plist, so macOS would refuse the request. Rebuild the app (the bundled release, or a fresh `tauri dev` after `Info.plist` changed) and try again.");
                emit(&app, "error", None, Some(msg.clone()));
                return Err(msg);
            }
            // And the microphone itself has to be allowed. Under the hardened
            // runtime a refusal is silent — zeroes rather than an error — so
            // settle it here instead of recording nothing.
            match permission::status() {
                permission::Mic::Granted => self.begin(app, &model),
                permission::Mic::Denied => {
                    emit(&app, "error", None, Some(MIC_DENIED.into()));
                    Err(MIC_DENIED.into())
                }
                permission::Mic::Ask => {
                    // The prompt is answered on another thread; the dictation
                    // carries on from there, reporting through events because
                    // the command that asked for it has long since returned.
                    let me = self.clone();
                    permission::request(move |granted| {
                        if !granted {
                            emit(&app, "error", None, Some(MIC_DENIED.into()));
                            return;
                        }
                        if let Err(e) = me.begin(app.clone(), &model) {
                            emit(&app, "error", None, Some(e));
                        }
                    });
                    Ok(())
                }
            }
        }

        fn begin(self: &Arc<Self>, app: AppHandle, model: &str) -> Result<(), String> {
            if model == APPLE {
                self.start_apple(app)
            } else {
                self.start_local(app, model)
            }
        }

        fn open_capture(&self) -> Result<Opened, String> {
            let settings = crate::store::settings::load();
            let restore = if settings.transcription_mute {
                let level = volume::get();
                volume::set(0);
                level
            } else {
                None
            };
            let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
            match audio::Capture::start(settings.transcription_input_device.clone(), tx) {
                Ok((capture, opening)) => Ok(Opened { capture, frames: rx, opening, restore_volume: restore }),
                Err(e) => {
                    if let Some(l) = restore {
                        volume::set(l);
                    }
                    Err(format!("{e:#}"))
                }
            }
        }

        /// The microphone opens on its own thread, so the failure — a denied
        /// permission, an unplugged device — arrives after the command that
        /// asked for it has returned. Wait for it here and, if it is bad news,
        /// tell the reader and put everything back.
        fn watch_capture(self: &Arc<Self>, app: AppHandle, opening: audio::Opening) {
            let me = self.clone();
            let spawned = std::thread::Builder::new().name("mic-opening".into()).spawn(move || {
                let outcome = opening.recv().unwrap_or_else(|_| Err("The microphone stopped before it started.".into()));
                if let Err(message) = outcome {
                    emit(&app, "error", None, Some(message));
                    me.finish(&app);
                }
            });
            if let Err(e) = spawned {
                log::warn!("could not watch the microphone opening: {e}");
            }
        }

        // ---- local models

        fn start_local(self: &Arc<Self>, app: AppHandle, id: &str) -> Result<(), String> {
            let spec = crate::transcription::catalog::find(id).ok_or_else(|| format!("unknown model {id}"))?;
            let path = crate::transcription::download::model_path(spec).map_err(|e| e.to_string())?;
            let Opened { capture, frames, opening, restore_volume } = self.open_capture()?;
            let audio = Arc::new(Mutex::new(Vec::<f32>::new()));
            let sink = audio.clone();
            std::thread::Builder::new()
                .name("dictation-pump".into())
                .spawn(move || {
                    for chunk in frames {
                        sink.lock().unwrap().extend_from_slice(&chunk);
                    }
                })
                .map_err(|e| e.to_string())?;
            self.stopping.store(false, Ordering::SeqCst);
            *self.active.lock().unwrap() = Some(Active { capture: Some(capture), route: Route::Local { id: id.into(), path, audio }, restore_volume });
            emit(&app, "listening", None, None);
            // Only once `active` holds the capture, so a failure can undo it.
            self.watch_capture(app, opening);
            Ok(())
        }

        // ---- Apple

        fn start_apple(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
            let me = self.clone();
            let app2 = app.clone();
            let begin = move |status: SFSpeechRecognizerAuthorizationStatus| {
                if status != SFSpeechRecognizerAuthorizationStatus::Authorized {
                    emit(&app2, "error", None, Some("Speech recognition is not allowed. Enable it for Raccoon under System Settings → Privacy & Security → Speech Recognition, or pick a local model in Settings → Transcription.".into()));
                    return;
                }
                let me = me.clone();
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    if let Err(e) = me.begin_apple_on_main(app3.clone()) {
                        emit(&app3, "error", None, Some(e));
                    }
                });
            };
            unsafe {
                let status = SFSpeechRecognizer::authorizationStatus();
                if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
                    begin(status);
                } else {
                    let block = RcBlock::new(move |s: SFSpeechRecognizerAuthorizationStatus| begin(s));
                    SFSpeechRecognizer::requestAuthorization(&block);
                }
            }
            Ok(())
        }

        fn begin_apple_on_main(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
            unsafe {
                let recognizer = SFSpeechRecognizer::new();
                if !recognizer.isAvailable() {
                    return Err("Speech recognition is not available for your language right now.".into());
                }
                let request = SFSpeechAudioBufferRecognitionRequest::new();
                request.setShouldReportPartialResults(true);
                if recognizer.supportsOnDeviceRecognition() {
                    request.setRequiresOnDeviceRecognition(true);
                }
                request.setAddsPunctuation(true);

                let Opened { capture, frames, opening, restore_volume } = self.open_capture()?;

                // Frames arrive on the capture thread; wrap them as PCM buffers
                // in the recogniser's standard 16 kHz mono float layout.
                let handle = RequestHandle(request.clone());
                self.heard.store(false, Ordering::SeqCst);
                self.produced.store(false, Ordering::SeqCst);
                let heard = self.heard.clone();
                std::thread::Builder::new()
                    .name("dictation-pump".into())
                    .spawn(move || {
                        let handle = handle;
                        let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(AVAudioFormat::alloc(), TARGET_RATE as f64, 1);
                        let Some(format) = format else { return };
                        for chunk in frames {
                            if chunk.is_empty() {
                                continue;
                            }
                            if !heard.load(Ordering::Relaxed) && chunk.iter().any(|s| *s != 0.0) {
                                heard.store(true, Ordering::Relaxed);
                            }
                            let Some(buffer) = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(AVAudioPCMBuffer::alloc(), &format, chunk.len() as u32) else { continue };
                            let channels = buffer.floatChannelData();
                            if channels.is_null() {
                                continue;
                            }
                            let ch0 = (*channels).as_ptr();
                            std::ptr::copy_nonoverlapping(chunk.as_ptr(), ch0, chunk.len());
                            buffer.setFrameLength(chunk.len() as u32);
                            handle.0.appendAudioPCMBuffer(&buffer);
                        }
                    })
                    .map_err(|e| e.to_string())?;

                let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
                self.stopping.store(false, Ordering::SeqCst);
                let gen_ref = self.generation.clone();
                let stopping = self.stopping.clone();
                let produced = self.produced.clone();
                let app_h = app.clone();
                let me = self.clone();
                let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                    if gen_ref.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    if !result.is_null() {
                        let result = &*result;
                        let text = result.bestTranscription().formattedString().to_string();
                        if !text.trim().is_empty() {
                            produced.store(true, Ordering::SeqCst);
                        }
                        if result.isFinal() {
                            emit(&app_h, "final", Some(text), None);
                            if stopping.load(Ordering::SeqCst) {
                                me.finish(&app_h);
                            }
                        } else {
                            emit(&app_h, "partial", Some(text), None);
                        }
                    }
                    if !error.is_null() {
                        let err = &*error;
                        // Ending the audio on purpose surfaces as a cancellation
                        // or "no speech"; neither is a failure worth showing.
                        if !stopping.load(Ordering::SeqCst) {
                            emit(&app_h, "error", None, Some(err.localizedDescription().to_string()));
                        }
                        me.finish(&app_h);
                    }
                });
                let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
                *self.active.lock().unwrap() = Some(Active {
                    capture: Some(capture),
                    route: Route::Apple { request, task, _recognizer: recognizer, _handler: handler },
                    restore_volume,
                });
                emit(&app, "listening", None, None);
                // Only once `active` holds the capture, so a failure can undo it.
                self.watch_capture(app, opening);
                Ok(())
            }
        }

        /// Stop the microphone; the engine then finishes the last phrase.
        pub fn stop(self: &Arc<Self>, app: AppHandle, transcription: Arc<Transcription>) -> Result<(), String> {
            if !self.is_active() {
                return Ok(());
            }
            self.stopping.store(true, Ordering::SeqCst);
            // Closing the capture ends the frame channel, which ends the pump.
            let local = {
                let mut guard = self.active.lock().unwrap();
                let Some(a) = guard.as_mut() else { return Ok(()) };
                a.capture = None;
                match &a.route {
                    Route::Local { id, path, audio } => Some((id.clone(), path.clone(), audio.clone())),
                    Route::Apple { .. } => None,
                }
            };
            if let Some((id, path, audio)) = local {
                emit(&app, "transcribing", None, None);
                let me = self.clone();
                std::thread::Builder::new()
                    .name("dictation-transcribe".into())
                    .spawn(move || {
                        // The pump may still be draining the last chunk.
                        std::thread::sleep(std::time::Duration::from_millis(60));
                        let samples = audio.lock().unwrap().clone();
                        if is_silent(&samples) {
                            emit(&app, "error", None, Some(NO_AUDIO.into()));
                        } else {
                            match transcription.engine.transcribe(&id, &path, &samples) {
                                // A model can be handed real speech and still
                                // make no words of it. An empty composer would
                                // read as a dictation that quietly vanished.
                                Ok(text) if text.trim().is_empty() => emit(&app, "error", None, Some(NOT_RECOGNISED.into())),
                                Ok(text) => emit(&app, "final", Some(text), None),
                                Err(e) => emit(&app, "error", None, Some(format!("{e:#}"))),
                            }
                        }
                        me.finish(&app);
                    })
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            let me = self.clone();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(a) = me.active.lock().unwrap().as_ref() {
                    if let Route::Apple { request, .. } = &a.route {
                        unsafe { request.endAudio() };
                    }
                }
                // The final result normally lands within a moment; if the
                // recogniser stays silent, close out anyway.
                let me2 = me.clone();
                let app3 = app2.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if me2.is_active() {
                        me2.finish(&app3);
                    }
                });
            });
            Ok(())
        }

        /// Release everything, put the volume back, and tell the UI. Safe to
        /// call twice.
        fn finish(&self, app: &AppHandle) {
            let taken = self.active.lock().unwrap().take();
            if let Some(mut a) = taken {
                if let Some(level) = a.restore_volume.take() {
                    volume::set(level);
                }
                // A recogniser that finishes a stopped dictation with no words,
                // over audio that never held a single non-zero sample, was
                // reading a microphone that was never really open. The local
                // route says so from its buffer; this is the same answer.
                if matches!(a.route, Route::Apple { .. })
                    && self.stopping.load(Ordering::SeqCst)
                    && !self.produced.load(Ordering::SeqCst)
                    && !self.heard.load(Ordering::SeqCst)
                {
                    emit(app, "error", None, Some(NO_AUDIO.into()));
                }
                let app = app.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    if let Route::Apple { task, .. } = &a.route {
                        unsafe { task.cancel() };
                    }
                    drop(a);
                    emit(&app, "stopped", None, None);
                });
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{is_silent, TARGET_RATE};

        const SECOND: usize = TARGET_RATE as usize;

        #[test]
        fn a_buffer_of_zeroes_is_silence() {
            assert!(is_silent(&vec![0.0; SECOND]));
        }

        #[test]
        fn nothing_at_all_is_silence() {
            assert!(is_silent(&[]));
        }

        #[test]
        fn a_buffer_under_a_quarter_second_is_silence_however_loud() {
            assert!(is_silent(&vec![0.8; SECOND / 4 - 1]));
        }

        #[test]
        fn one_faint_sample_in_a_long_buffer_is_not_silence() {
            let mut samples = vec![0.0f32; SECOND];
            samples[SECOND / 2] = -0.0001;
            assert!(!is_silent(&samples));
        }

        #[test]
        fn a_quarter_second_of_speech_is_not_silence() {
            assert!(!is_silent(&vec![0.2; SECOND / 4]));
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::Dictation;

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct Dictation {
    _unused: Mutex<()>,
}

#[cfg(not(target_os = "macos"))]
impl Dictation {
    pub fn available() -> bool {
        false
    }
    pub fn is_active(&self) -> bool {
        false
    }
    pub fn start(self: &std::sync::Arc<Self>, app: AppHandle, _t: std::sync::Arc<crate::transcription::Transcription>) -> Result<(), String> {
        emit(&app, "error", None, Some("Dictation is only available on macOS.".into()));
        Err("Dictation is only available on macOS.".into())
    }
    pub fn stop(self: &std::sync::Arc<Self>, _app: AppHandle, _t: std::sync::Arc<crate::transcription::Transcription>) -> Result<(), String> {
        Ok(())
    }
}
