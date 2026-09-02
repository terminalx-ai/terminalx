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

fn emit(app: &AppHandle, kind: &'static str, text: Option<String>, message: Option<String>) {
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

    /// The microphone, its frame stream, and the volume to put back afterwards.
    type Opened = (audio::Capture, Receiver<Vec<f32>>, Option<u8>);

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
            if model == APPLE {
                self.start_apple(app)
            } else {
                self.start_local(app, &model)
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
            match audio::Capture::start(settings.transcription_input_device.as_deref(), tx) {
                Ok(c) => Ok((c, rx, restore)),
                Err(e) => {
                    if let Some(l) = restore {
                        volume::set(l);
                    }
                    Err(format!("{e:#}"))
                }
            }
        }

        // ---- local models

        fn start_local(self: &Arc<Self>, app: AppHandle, id: &str) -> Result<(), String> {
            let spec = crate::transcription::catalog::find(id).ok_or_else(|| format!("unknown model {id}"))?;
            let path = crate::transcription::download::model_path(spec).map_err(|e| e.to_string())?;
            let (capture, rx, restore_volume) = self.open_capture()?;
            let audio = Arc::new(Mutex::new(Vec::<f32>::new()));
            let sink = audio.clone();
            std::thread::Builder::new()
                .name("dictation-pump".into())
                .spawn(move || {
                    for chunk in rx {
                        sink.lock().unwrap().extend_from_slice(&chunk);
                    }
                })
                .map_err(|e| e.to_string())?;
            self.stopping.store(false, Ordering::SeqCst);
            *self.active.lock().unwrap() = Some(Active { capture: Some(capture), route: Route::Local { id: id.into(), path, audio }, restore_volume });
            emit(&app, "listening", None, None);
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

                let (capture, rx, restore_volume) = self.open_capture()?;

                // Frames arrive on the capture thread; wrap them as PCM buffers
                // in the recogniser's standard 16 kHz mono float layout.
                let handle = RequestHandle(request.clone());
                std::thread::Builder::new()
                    .name("dictation-pump".into())
                    .spawn(move || {
                        let handle = handle;
                        let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(AVAudioFormat::alloc(), TARGET_RATE as f64, 1);
                        let Some(format) = format else { return };
                        for chunk in rx {
                            if chunk.is_empty() {
                                continue;
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
                let app_h = app.clone();
                let me = self.clone();
                let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                    if gen_ref.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    if !result.is_null() {
                        let result = &*result;
                        let text = result.bestTranscription().formattedString().to_string();
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
                        match transcription.engine.transcribe(&id, &path, &samples) {
                            Ok(text) => {
                                if !text.is_empty() {
                                    emit(&app, "final", Some(text), None);
                                }
                            }
                            Err(e) => emit(&app, "error", None, Some(format!("{e:#}"))),
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
