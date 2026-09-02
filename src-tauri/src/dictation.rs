//! Dictation: the microphone into Apple's speech recogniser, text out as
//! events. On-device recognition is asked for whenever the recogniser
//! supports it, so nothing leaves the machine and there is no model to
//! download; the OS prompts once for the microphone and once for speech.
//!
//! All AVFoundation and Speech objects are touched on the main thread. They
//! are kept in the shared state between start and stop so the audio tap and
//! the result handler stay alive for as long as the recogniser needs them.

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

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_avf_audio::{AVAudioEngine, AVAudioInputNode, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::NSError;
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
    };
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Arc;

    /// Everything a running dictation owns. Dropped on stop, which releases
    /// the engine, the request and both blocks together.
    pub struct Active {
        engine: Retained<AVAudioEngine>,
        input: Retained<AVAudioInputNode>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        task: Retained<SFSpeechRecognitionTask>,
        _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
        _handler: RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)>,
        _recognizer: Retained<SFSpeechRecognizer>,
    }
    // Only ever used from the main thread; the mutex in `Dictation` just
    // moves the handle between commands.
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
            unsafe {
                let r = SFSpeechRecognizer::new();
                r.isAvailable()
            }
        }

        pub fn is_active(&self) -> bool {
            self.active.lock().unwrap().is_some()
        }

        /// Ask for speech permission, then begin on the main thread.
        pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
            if self.is_active() {
                return Ok(());
            }
            let me = self.clone();
            let app2 = app.clone();
            let begin = move |status: SFSpeechRecognizerAuthorizationStatus| {
                if status != SFSpeechRecognizerAuthorizationStatus::Authorized {
                    emit(&app2, "error", None, Some("Speech recognition is not allowed. Enable it for Raccoon under System Settings → Privacy & Security → Speech Recognition.".into()));
                    return;
                }
                let me = me.clone();
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    if let Err(e) = me.begin_on_main(app3.clone()) {
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

        fn begin_on_main(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
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

                let engine = AVAudioEngine::new();
                let input = engine.inputNode();
                let format = input.outputFormatForBus(0);
                if format.sampleRate() <= 0.0 || format.channelCount() == 0 {
                    return Err("No microphone input is available.".into());
                }
                let req_for_tap = request.clone();
                let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                    req_for_tap.appendAudioPCMBuffer(buffer.as_ref());
                });
                input.installTapOnBus_bufferSize_format_block(0, 2048, Some(&format), &*tap as *const _ as *mut _);
                engine.prepare();
                if let Err(e) = engine.startAndReturnError() {
                    input.removeTapOnBus(0);
                    return Err(format!("Could not start the microphone: {}", e.localizedDescription()));
                }

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
                        if stopping.load(Ordering::SeqCst) {
                            me.finish(&app_h);
                        } else {
                            emit(&app_h, "error", None, Some(err.localizedDescription().to_string()));
                            me.finish(&app_h);
                        }
                    }
                });
                let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
                *self.active.lock().unwrap() = Some(Active { engine, input, request, task, _tap: tap, _handler: handler, _recognizer: recognizer });
                emit(&app, "listening", None, None);
                Ok(())
            }
        }

        /// Stop the microphone and let the recogniser finish the last phrase.
        pub fn stop(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
            if !self.is_active() {
                return Ok(());
            }
            self.stopping.store(true, Ordering::SeqCst);
            let me = self.clone();
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                let guard = me.active.lock().unwrap();
                if let Some(a) = guard.as_ref() {
                    unsafe {
                        a.engine.stop();
                        a.input.removeTapOnBus(0);
                        a.request.endAudio();
                    }
                }
                drop(guard);
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

        /// Release everything and tell the UI. Safe to call twice.
        fn finish(&self, app: &AppHandle) {
            let taken = self.active.lock().unwrap().take();
            if let Some(a) = taken {
                let app = app.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    unsafe {
                        if a.engine.isRunning() {
                            a.engine.stop();
                            a.input.removeTapOnBus(0);
                        }
                        a.task.cancel();
                    }
                    drop(a);
                    emit(&app, "stopped", None, None);
                });
            }
        }
    }

    // ProtocolObject is referenced so the delegate-free path type-checks on
    // every SDK; nothing here installs a delegate.
    #[allow(dead_code)]
    fn _keep(_: &ProtocolObject<dyn objc2::runtime::NSObjectProtocol>) {}
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
    pub fn start(self: &std::sync::Arc<Self>, app: AppHandle) -> Result<(), String> {
        emit(&app, "error", None, Some("Dictation is only available on macOS.".into()));
        Err("Dictation is only available on macOS.".into())
    }
    pub fn stop(self: &std::sync::Arc<Self>, _app: AppHandle) -> Result<(), String> {
        Ok(())
    }
}
