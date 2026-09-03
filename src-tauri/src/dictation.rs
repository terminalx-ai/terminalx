//! Dictation: the microphone into text, out as events. The microphone is
//! read through `cpal` (so the reader can pick a device) and its 16 kHz mono
//! frames go to whichever engine is selected: Apple's speech recogniser,
//! on-device where it can be, with partial results as they arrive; or a
//! local model from the catalog, transcribed in one go when the reader stops.
//!
//! Apple's objects are created and torn down on the main thread; the frame
//! pump feeds the recogniser from its own thread, which the framework allows.
//!
//! Observed on macOS 26.3.1 (25D771280a), en-US, with Apple's on-device
//! recogniser and the built-in microphone: after one phrase and six seconds
//! of actual output silence, capture and the listening UI remained active but
//! a second phrase produced no callback. A delivered final has task state
//! `Completed` (4), so its request is spent; continuing dictation requires a
//! new request and task rather than more buffers on the old request.

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
    /// The System Settings privacy pane that can resolve this error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<&'static str>,
    /// Stable within one Apple transcription segment and incremented at a
    /// timestamp boundary. Other engines leave it absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment: Option<u64>,
}

/// Every event, into the log before it goes out. Dictation goes wrong in the
/// field — a recogniser that stops sending, a segment in a shape nobody
/// expected — and the only way to tell that from a composer that mishandled it
/// is a record of what was actually emitted. Run the binary with `RUST_LOG=debug`
/// to see it, next to the webview's own line for the same event.
fn trace(kind: &str, text: Option<&str>, message: Option<&str>, segment: Option<u64>) {
    let segment = segment.map_or_else(String::new, |index| format!(" segment={index}"));
    let detail = match (text, message) {
        (Some(t), _) => {
            let head: String = t.chars().take(40).collect();
            let more = if t.chars().count() > 40 { "…" } else { "" };
            format!(" len={} {:?}", t.chars().count(), format!("{head}{more}"))
        }
        (None, Some(m)) => format!(" {m}"),
        (None, None) => String::new(),
    };
    log::debug!("dictation emit {kind}{segment}{detail}");
}

fn emit(app: &AppHandle, kind: &'static str, text: Option<String>, message: Option<String>) {
    emit_segment(app, kind, text, message, None);
}

fn emit_privacy_error(app: &AppHandle, message: String, settings: &'static str) {
    trace("error", None, Some(&message), None);
    let _ = app.emit(
        "dictation",
        DictationEvent { kind: "error", text: None, message: Some(message), settings: Some(settings), segment: None },
    );
}

fn emit_segment(app: &AppHandle, kind: &'static str, text: Option<String>, message: Option<String>, segment: Option<u64>) {
    trace(kind, text.as_deref(), message.as_deref(), segment);
    let _ = app.emit("dictation", DictationEvent { kind, text, message, settings: None, segment });
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
    use objc2_speech::{SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer, SFTranscription};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc::Receiver;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const RESTART_INTERVAL: Duration = Duration::from_secs(2);
    const MAX_RESTARTS: u32 = 30;
    const RESTART_LIMIT: &str = "Dictation stopped because speech recognition repeatedly ended. Start dictation again to continue.";
    const NO_SPEECH_DOMAIN: &str = "kAFAssistantErrorDomain";
    const NO_SPEECH_CODE: isize = 1110;

    #[derive(Debug, PartialEq, Eq)]
    enum RestartDecision {
        Ignore,
        Finish,
        Restart,
        Fail,
    }

    fn restart_decision(
        is_final: bool,
        stopping: bool,
        generation_matches: bool,
        capture_present: bool,
        restart_count: u32,
        elapsed_since_restart: Duration,
    ) -> RestartDecision {
        if !is_final {
            return RestartDecision::Ignore;
        }
        if stopping {
            return RestartDecision::Finish;
        }
        if !generation_matches || !capture_present {
            return RestartDecision::Ignore;
        }
        if restart_count >= MAX_RESTARTS || elapsed_since_restart < RESTART_INTERVAL {
            return RestartDecision::Fail;
        }
        RestartDecision::Restart
    }

    fn is_no_speech_error(domain: &str, code: isize) -> bool {
        domain == NO_SPEECH_DOMAIN && code == NO_SPEECH_CODE
    }

    /// Shown when the microphone was open but delivered nothing: no frames at
    /// all, or nothing but zeroes. That is what an unpermitted or muted input
    /// looks like from here, and it must never pass as a successful dictation.
    const NO_AUDIO: &str = "The microphone delivered no audio. Check the input under Settings → Transcription and that TerminalX is allowed to use the microphone.";
    /// Shown when a local model heard real sound and still made no words of it.
    const NOT_RECOGNISED: &str = "Nothing was recognised. Try again, speak closer to the microphone, or pick another model under Settings → Transcription.";
    /// Shown when macOS will not let this app near the microphone at all.
    const MIC_DENIED: &str = "TerminalX is not allowed to use the microphone. Enable it under System Settings → Privacy & Security → Microphone.";
    /// Shown when the system recogniser cannot be used, with a route to the
    /// privacy pane that can change the decision.
    const SPEECH_DENIED: &str = "Speech recognition is not allowed. Enable it for TerminalX under System Settings → Privacy & Security → Speech Recognition, or pick a local model in Settings → Transcription.";
    /// Timestamp movement smaller than this can be a recogniser correction,
    /// not a new spoken segment.
    const SEGMENT_TIMESTAMP_TOLERANCE: f64 = 0.05;

    #[derive(Debug, Clone, Copy)]
    struct LiveSegment {
        index: u64,
        end: f64,
    }

    /// Turns Apple's shifting timestamp ranges into a stable identity that the
    /// frontend can trust while the words inside the segment are revised.
    #[derive(Debug, Default)]
    struct AppleSegmentTracker {
        next: u64,
        live: Option<LiveSegment>,
    }

    impl AppleSegmentTracker {
        fn observe(&mut self, bounds: Option<(f64, f64)>, is_final: bool) -> Option<u64> {
            let Some((start, end)) = bounds.filter(|(start, end)| start.is_finite() && end.is_finite() && *start >= 0.0 && *end >= *start) else {
                if is_final {
                    self.live = None;
                }
                return None;
            };
            let current = match self.live {
                Some(live) if start <= live.end + SEGMENT_TIMESTAMP_TOLERANCE => LiveSegment { index: live.index, end: live.end.max(end) },
                _ => {
                    let live = LiveSegment { index: self.next, end };
                    self.next += 1;
                    live
                }
            };
            self.live = (!is_final).then_some(current);
            Some(current.index)
        }

        /// A fresh Apple request restarts its timestamps at zero. Close any
        /// live range without resetting `next`, so its results cannot look like
        /// revisions of the request that just ended.
        fn restart_request(&mut self) {
            self.live = None;
        }
    }

    fn apple_segment_bounds(transcription: &SFTranscription) -> Option<(f64, f64)> {
        unsafe {
            let segments = transcription.segments();
            let first = segments.firstObject()?;
            let last = segments.lastObject()?;
            Some((first.timestamp(), last.timestamp() + last.duration()))
        }
    }

    /// Whether a captured buffer is worth handing to an engine. Anything under
    /// a quarter second cannot hold a word, and a buffer of exact zeroes is
    /// what a microphone the app may not open delivers.
    fn is_silent(samples: &[f32]) -> bool {
        samples.len() < TARGET_RATE as usize / 4 || samples.iter().all(|s| *s == 0.0)
    }

    /// The two privacy services dictation can need. The gateway makes the
    /// boundary injectable: passive app paths can be tested without touching
    /// TCC, and a deliberate start can request both services in one flow.
    mod permission {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaType, AVMediaTypeAudio};
        use objc2_speech::{SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
        use std::sync::{Arc, Mutex};

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Status {
            Granted,
            Denied,
            /// Never asked; a prompt will be raised.
            Ask,
        }

        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum Kind {
            Microphone,
            SpeechRecognition,
        }

        type PermissionCallback = Box<dyn Fn(bool) + Send + 'static>;
        type Completion = Box<dyn FnOnce(Result<(), Kind>) + Send + 'static>;

        pub trait Gateway: Send + Sync {
            fn microphone_status(&self) -> Status;
            fn speech_status(&self) -> Status;
            fn request_microphone(&self, then: PermissionCallback);
            fn request_speech(&self, then: PermissionCallback);
        }

        pub struct SystemGateway;

        /// The audio media type constant, or `None` if AVFoundation did not
        /// load — in which case there is nothing to ask and nothing to refuse.
        fn audio() -> Option<&'static AVMediaType> {
            unsafe { AVMediaTypeAudio }
        }

        fn microphone_status() -> Status {
            let Some(media) = audio() else { return Status::Granted };
            match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) } {
                AVAuthorizationStatus::Authorized => Status::Granted,
                AVAuthorizationStatus::NotDetermined => Status::Ask,
                _ => Status::Denied,
            }
        }

        fn request_microphone(then: PermissionCallback) {
            let Some(media) = audio() else {
                then(true);
                return;
            };
            let block = RcBlock::new(move |granted: Bool| then(granted.as_bool()));
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &block) };
        }

        fn speech_status() -> Status {
            match unsafe { SFSpeechRecognizer::authorizationStatus() } {
                SFSpeechRecognizerAuthorizationStatus::Authorized => Status::Granted,
                SFSpeechRecognizerAuthorizationStatus::NotDetermined => Status::Ask,
                _ => Status::Denied,
            }
        }

        fn request_speech(then: PermissionCallback) {
            let block = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
                then(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
            });
            unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
        }

        impl Gateway for SystemGateway {
            fn microphone_status(&self) -> Status {
                microphone_status()
            }

            fn speech_status(&self) -> Status {
                speech_status()
            }

            fn request_microphone(&self, then: PermissionCallback) {
                request_microphone(then);
            }

            fn request_speech(&self, then: PermissionCallback) {
                request_speech(then);
            }
        }

        pub enum Start {
            Ready,
            Denied(Kind),
            Pending,
        }

        struct Pending {
            microphone: Option<bool>,
            speech: Option<bool>,
            complete: Option<Completion>,
        }

        fn record(pending: &Arc<Mutex<Pending>>, kind: Kind, granted: bool) {
            let completion = {
                let mut state = pending.lock().unwrap();
                match kind {
                    Kind::Microphone => state.microphone = Some(granted),
                    Kind::SpeechRecognition => state.speech = Some(granted),
                }
                let result = if state.microphone == Some(false) {
                    Some(Err(Kind::Microphone))
                } else if state.speech == Some(false) {
                    Some(Err(Kind::SpeechRecognition))
                } else if state.microphone == Some(true) && state.speech == Some(true) {
                    Some(Ok(()))
                } else {
                    None
                };
                if let Some(result) = result {
                    state.complete.take().map(|complete| (complete, result))
                } else {
                    None
                }
            };
            if let Some((complete, result)) = completion {
                complete(result);
            }
        }

        /// Check both services only in response to a dictation start. When both
        /// are undecided their prompts are initiated together; the recogniser
        /// starts only after both callbacks have granted access.
        pub fn begin(
            gateway: Arc<dyn Gateway>,
            needs_speech: bool,
            complete: impl FnOnce(Result<(), Kind>) + Send + 'static,
        ) -> Start {
            let microphone = gateway.microphone_status();
            let speech = if needs_speech { gateway.speech_status() } else { Status::Granted };
            if microphone == Status::Denied {
                return Start::Denied(Kind::Microphone);
            }
            if speech == Status::Denied {
                return Start::Denied(Kind::SpeechRecognition);
            }
            if microphone == Status::Granted && speech == Status::Granted {
                return Start::Ready;
            }

            let pending = Arc::new(Mutex::new(Pending {
                microphone: (microphone == Status::Granted).then_some(true),
                speech: (speech == Status::Granted).then_some(true),
                complete: Some(Box::new(complete)),
            }));
            if microphone == Status::Ask {
                let state = pending.clone();
                gateway.request_microphone(Box::new(move |granted| record(&state, Kind::Microphone, granted)));
            }
            if speech == Status::Ask {
                let state = pending.clone();
                gateway.request_speech(Box::new(move |granted| record(&state, Kind::SpeechRecognition, granted)));
            }
            Start::Pending
        }
    }

    fn emit_permission_denied(app: &AppHandle, kind: permission::Kind) -> String {
        let (message, settings) = match kind {
            permission::Kind::Microphone => (MIC_DENIED, "microphone"),
            permission::Kind::SpeechRecognition => (SPEECH_DENIED, "speechRecognition"),
        };
        emit_privacy_error(app, message.into(), settings);
        message.into()
    }

    /// A recogniser request handed to the pump thread. The framework accepts
    /// buffers from any thread; only creation and teardown stay on main.
    struct RequestHandle(Retained<SFSpeechAudioBufferRecognitionRequest>);
    unsafe impl Send for RequestHandle {}

    type SharedRequest = Arc<Mutex<RequestHandle>>;

    enum Route {
        Apple {
            request: SharedRequest,
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

    pub struct Dictation {
        active: Mutex<Option<Active>>,
        permissions: Arc<dyn permission::Gateway>,
        /// Bumped per start; a result handler from an older run is ignored.
        generation: Arc<AtomicU64>,
        stopping: Arc<AtomicBool>,
        /// Set once the capture delivers a sample that is not exactly zero.
        /// The Apple route has no buffer to inspect afterwards, so the pump
        /// answers the same question the local route asks of its samples.
        heard: Arc<AtomicBool>,
        /// Set once the recogniser hands back a transcript with words in it.
        produced: Arc<AtomicBool>,
        /// Stable Apple segment identities for the current dictation.
        segments: Arc<Mutex<AppleSegmentTracker>>,
        /// Number of recognition tasks rotated into this dictation session.
        restarts: AtomicU32,
        /// A recogniser that immediately completes every new task must not spin.
        last_restart: Mutex<Instant>,
    }

    impl Default for Dictation {
        fn default() -> Self {
            Self::with_permissions(Arc::new(permission::SystemGateway))
        }
    }

    impl Dictation {
        fn with_permissions(permissions: Arc<dyn permission::Gateway>) -> Self {
            let now = Instant::now();
            Self {
                active: Mutex::new(None),
                permissions,
                generation: Arc::new(AtomicU64::new(0)),
                stopping: Arc::new(AtomicBool::new(false)),
                heard: Arc::new(AtomicBool::new(false)),
                produced: Arc::new(AtomicBool::new(false)),
                segments: Arc::new(Mutex::new(AppleSegmentTracker::default())),
                restarts: AtomicU32::new(0),
                last_restart: Mutex::new(now.checked_sub(RESTART_INTERVAL).unwrap_or(now)),
            }
        }
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
            // Under the hardened runtime a microphone refusal is silent —
            // zeroes rather than an error — so settle every privacy service
            // this engine needs before opening the capture.
            let needs_speech = model == APPLE;
            let me = self.clone();
            let continuation_app = app.clone();
            let continuation_model = model.clone();
            let continue_after_prompt = move |result: Result<(), permission::Kind>| match result {
                Ok(()) => {
                    if let Err(error) = me.begin(continuation_app.clone(), &continuation_model) {
                        emit(&continuation_app, "error", None, Some(error));
                    }
                }
                Err(kind) => {
                    emit_permission_denied(&continuation_app, kind);
                }
            };
            match permission::begin(self.permissions.clone(), needs_speech, continue_after_prompt) {
                permission::Start::Ready => self.begin(app, &model),
                permission::Start::Denied(kind) => {
                    let message = emit_permission_denied(&app, kind);
                    Err(message)
                }
                permission::Start::Pending => Ok(()),
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
            let app_on_main = app.clone();
            app.run_on_main_thread(move || {
                if let Err(error) = me.begin_apple_on_main(app_on_main.clone()) {
                    emit(&app_on_main, "error", None, Some(error));
                }
            })
            .map_err(|error| error.to_string())?;
            Ok(())
        }

        unsafe fn configured_apple_request(recognizer: &SFSpeechRecognizer) -> Retained<SFSpeechAudioBufferRecognitionRequest> {
            let request = SFSpeechAudioBufferRecognitionRequest::new();
            request.setShouldReportPartialResults(true);
            if recognizer.supportsOnDeviceRecognition() {
                request.setRequiresOnDeviceRecognition(true);
            }
            request.setAddsPunctuation(true);
            request
        }

        unsafe fn apple_result_handler(
            self: &Arc<Self>,
            app: AppHandle,
            generation: u64,
        ) -> RcBlock<dyn Fn(*mut SFSpeechRecognitionResult, *mut NSError)> {
            let gen_ref = self.generation.clone();
            let stopping = self.stopping.clone();
            let produced = self.produced.clone();
            let segments = self.segments.clone();
            let me = self.clone();
            RcBlock::new(move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                if gen_ref.load(Ordering::SeqCst) != generation {
                    return;
                }
                let mut handled_final = false;
                if !result.is_null() {
                    let result = &*result;
                    let transcription = result.bestTranscription();
                    let text = transcription.formattedString().to_string();
                    let is_final = result.isFinal();
                    let segment = segments.lock().unwrap().observe(apple_segment_bounds(&transcription), is_final);
                    if !text.trim().is_empty() {
                        produced.store(true, Ordering::SeqCst);
                    }
                    if is_final {
                        handled_final = true;
                        let is_stopping = stopping.load(Ordering::SeqCst);
                        let task_state = me.active.lock().unwrap().as_ref().and_then(|active| match &active.route {
                            Route::Apple { task, .. } => Some(task.state()),
                            Route::Local { .. } => None,
                        });
                        log::debug!("dictation Apple final stopping={is_stopping} generation={generation} task_state={task_state:?}");
                        emit_segment(&app, "final", Some(text), None, segment);
                        if is_stopping {
                            me.finish(&app);
                        } else {
                            me.schedule_apple_restart(app.clone(), generation);
                        }
                    } else {
                        emit_segment(&app, "partial", Some(text), None, segment);
                    }
                }
                if !error.is_null() && !handled_final {
                    let err = &*error;
                    let domain = err.domain().to_string();
                    let code = err.code();
                    let is_stopping = stopping.load(Ordering::SeqCst);
                    log::debug!("dictation Apple error stopping={is_stopping} generation={generation} domain={domain:?} code={code}");
                    if is_stopping {
                        me.finish(&app);
                    } else if is_no_speech_error(&domain, code) {
                        me.schedule_apple_restart(app.clone(), generation);
                    } else {
                        emit(&app, "error", None, Some(err.localizedDescription().to_string()));
                        me.finish(&app);
                    }
                }
            })
        }

        fn schedule_apple_restart(self: &Arc<Self>, app: AppHandle, generation: u64) {
            let me = self.clone();
            let app_h = app.clone();
            let fallback = self.clone();
            let fallback_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || unsafe { me.restart_apple_on_main(app_h, generation) }) {
                emit(&fallback_app, "error", None, Some(format!("Speech recognition could not continue: {error}")));
                fallback.finish(&fallback_app);
            }
        }

        unsafe fn restart_apple_on_main(self: &Arc<Self>, app: AppHandle, generation: u64) {
            let generation_matches = self.generation.load(Ordering::SeqCst) == generation;
            let (capture_present, recognizer) = {
                let active = self.active.lock().unwrap();
                match active.as_ref() {
                    Some(Active { capture, route: Route::Apple { _recognizer, .. }, .. }) => {
                        (capture.is_some(), Some(_recognizer.clone()))
                    }
                    _ => (false, None),
                }
            };
            let decision = restart_decision(
                true,
                self.stopping.load(Ordering::SeqCst),
                generation_matches,
                capture_present,
                self.restarts.load(Ordering::SeqCst),
                self.last_restart.lock().unwrap().elapsed(),
            );
            match decision {
                RestartDecision::Ignore => return,
                RestartDecision::Finish => {
                    self.finish(&app);
                    return;
                }
                RestartDecision::Fail => {
                    emit(&app, "error", None, Some(RESTART_LIMIT.into()));
                    self.finish(&app);
                    return;
                }
                RestartDecision::Restart => {}
            }

            let Some(recognizer) = recognizer else { return };
            self.restarts.fetch_add(1, Ordering::SeqCst);
            *self.last_restart.lock().unwrap() = Instant::now();
            self.segments.lock().unwrap().restart_request();
            let request = Self::configured_apple_request(&recognizer);
            let handler = self.apple_result_handler(app.clone(), generation);
            let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);

            let mut guard = self.active.lock().unwrap();
            if self.generation.load(Ordering::SeqCst) != generation || self.stopping.load(Ordering::SeqCst) {
                task.cancel();
                return;
            }
            let Some(active) = guard.as_mut() else {
                task.cancel();
                return;
            };
            if active.capture.is_none() {
                task.cancel();
                return;
            }
            let Route::Apple { request: current_request, task: current_task, _handler: current_handler, .. } = &mut active.route else {
                task.cancel();
                return;
            };
            let old_request = std::mem::replace(&mut current_request.lock().unwrap().0, request);
            let old_task = std::mem::replace(current_task, task);
            let old_handler = std::mem::replace(current_handler, handler);
            let restart = self.restarts.load(Ordering::SeqCst);
            drop(guard);
            drop((old_request, old_task, old_handler));
            log::debug!("dictation Apple recognition restarted generation={generation} restart={restart}");
        }

        fn begin_apple_on_main(self: &Arc<Self>, app: AppHandle) -> Result<(), String> {
            unsafe {
                let recognizer = SFSpeechRecognizer::new();
                if !recognizer.isAvailable() {
                    return Err("Speech recognition is not available for your language right now.".into());
                }
                let request = Self::configured_apple_request(&recognizer);
                let shared_request = Arc::new(Mutex::new(RequestHandle(request.clone())));

                let Opened { capture, frames, opening, restore_volume } = self.open_capture()?;

                // Frames arrive on the capture thread; wrap them as PCM buffers
                // in the recogniser's standard 16 kHz mono float layout.
                let pump_request = shared_request.clone();
                self.heard.store(false, Ordering::SeqCst);
                self.produced.store(false, Ordering::SeqCst);
                let heard = self.heard.clone();
                std::thread::Builder::new()
                    .name("dictation-pump".into())
                    .spawn(move || {
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
                            pump_request.lock().unwrap().0.appendAudioPCMBuffer(&buffer);
                        }
                    })
                    .map_err(|e| e.to_string())?;

                let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
                self.stopping.store(false, Ordering::SeqCst);
                *self.segments.lock().unwrap() = AppleSegmentTracker::default();
                self.restarts.store(0, Ordering::SeqCst);
                let now = Instant::now();
                *self.last_restart.lock().unwrap() = now.checked_sub(RESTART_INTERVAL).unwrap_or(now);
                let handler = self.apple_result_handler(app.clone(), generation);
                let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
                *self.active.lock().unwrap() = Some(Active {
                    capture: Some(capture),
                    route: Route::Apple { request: shared_request, task, _recognizer: recognizer, _handler: handler },
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
                        unsafe { request.lock().unwrap().0.endAudio() };
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
        use super::{
            is_no_speech_error, is_silent, permission, restart_decision, AppleSegmentTracker,
            Dictation, RestartDecision, MAX_RESTARTS, NO_SPEECH_CODE, NO_SPEECH_DOMAIN,
            RESTART_INTERVAL, TARGET_RATE,
        };
        use std::sync::{Arc, Mutex};
        use std::time::Duration;

        const SECOND: usize = TARGET_RATE as usize;

        struct PermissionGateway {
            microphone: permission::Status,
            speech: permission::Status,
            calls: Mutex<Vec<&'static str>>,
        }

        impl PermissionGateway {
            fn asking() -> Self {
                Self {
                    microphone: permission::Status::Ask,
                    speech: permission::Status::Ask,
                    calls: Mutex::new(Vec::new()),
                }
            }

            fn with_statuses(microphone: permission::Status, speech: permission::Status) -> Self {
                Self { microphone, speech, calls: Mutex::new(Vec::new()) }
            }
        }

        impl permission::Gateway for PermissionGateway {
            fn microphone_status(&self) -> permission::Status {
                self.calls.lock().unwrap().push("microphone_status");
                self.microphone
            }

            fn speech_status(&self) -> permission::Status {
                self.calls.lock().unwrap().push("speech_status");
                self.speech
            }

            fn request_microphone(&self, then: Box<dyn Fn(bool) + Send + 'static>) {
                self.calls.lock().unwrap().push("request_microphone");
                then(true);
            }

            fn request_speech(&self, then: Box<dyn Fn(bool) + Send + 'static>) {
                self.calls.lock().unwrap().push("request_speech");
                then(true);
            }
        }

        #[test]
        fn creating_dictation_does_not_consult_the_permission_gateway() {
            let gateway = Arc::new(PermissionGateway::asking());

            let _dictation = Dictation::with_permissions(gateway.clone());

            assert!(gateway.calls.lock().unwrap().is_empty());
        }

        #[test]
        fn an_apple_dictation_start_requests_both_undecided_permissions() {
            let gateway = Arc::new(PermissionGateway::asking());
            let result = Arc::new(Mutex::new(None));
            let reported = result.clone();

            let start = permission::begin(gateway.clone(), true, move |outcome| {
                *reported.lock().unwrap() = Some(outcome);
            });

            assert!(matches!(start, permission::Start::Pending));
            assert_eq!(
                gateway.calls.lock().unwrap().as_slice(),
                ["microphone_status", "speech_status", "request_microphone", "request_speech"]
            );
            assert_eq!(*result.lock().unwrap(), Some(Ok(())));
        }

        #[test]
        fn a_local_dictation_start_never_consults_speech_permission() {
            let gateway = Arc::new(PermissionGateway::asking());

            let start = permission::begin(gateway.clone(), false, |_| {});

            assert!(matches!(start, permission::Start::Pending));
            assert_eq!(gateway.calls.lock().unwrap().as_slice(), ["microphone_status", "request_microphone"]);
        }

        #[test]
        fn either_denied_permission_stops_apple_dictation_before_a_request() {
            for (microphone, speech, expected) in [
                (permission::Status::Denied, permission::Status::Ask, permission::Kind::Microphone),
                (permission::Status::Granted, permission::Status::Denied, permission::Kind::SpeechRecognition),
            ] {
                let gateway = Arc::new(PermissionGateway::with_statuses(microphone, speech));

                let start = permission::begin(gateway.clone(), true, |_| panic!("a denied permission cannot complete successfully"));

                match start {
                    permission::Start::Denied(kind) => assert_eq!(kind, expected),
                    _ => panic!("a denied permission must stop before prompting"),
                }
                assert!(!gateway.calls.lock().unwrap().iter().any(|call| call.starts_with("request_")));
            }
        }

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

        #[test]
        fn timestamp_revisions_keep_the_same_segment() {
            let mut segments = AppleSegmentTracker::default();
            assert_eq!(segments.observe(Some((0.20, 0.75)), false), Some(0));
            assert_eq!(segments.observe(Some((0.18, 1.40)), false), Some(0));
        }

        #[test]
        fn a_timestamp_after_the_live_range_starts_a_new_segment() {
            let mut segments = AppleSegmentTracker::default();
            assert_eq!(segments.observe(Some((0.20, 1.40)), false), Some(0));
            assert_eq!(segments.observe(Some((2.95, 3.60)), false), Some(1));
        }

        #[test]
        fn a_final_result_closes_its_segment() {
            let mut segments = AppleSegmentTracker::default();
            assert_eq!(segments.observe(Some((0.20, 1.40)), true), Some(0));
            assert_eq!(segments.observe(Some((0.25, 0.90)), false), Some(1));
        }

        #[test]
        fn a_restarted_request_continues_segment_numbering() {
            let mut segments = AppleSegmentTracker::default();
            assert_eq!(segments.observe(Some((4.20, 5.10)), false), Some(0));

            segments.restart_request();

            assert_eq!(segments.observe(Some((0.10, 0.80)), false), Some(1));
        }

        #[test]
        fn an_early_final_restarts_recognition() {
            assert_eq!(restart_decision(true, false, true, true, 0, RESTART_INTERVAL), RestartDecision::Restart);
        }

        #[test]
        fn a_partial_result_does_not_restart() {
            assert_eq!(restart_decision(false, false, true, true, 0, RESTART_INTERVAL), RestartDecision::Ignore);
        }

        #[test]
        fn a_final_requested_by_stop_finishes() {
            assert_eq!(restart_decision(true, true, true, true, 0, RESTART_INTERVAL), RestartDecision::Finish);
        }

        #[test]
        fn an_old_generation_cannot_restart() {
            assert_eq!(restart_decision(true, false, false, true, 0, RESTART_INTERVAL), RestartDecision::Ignore);
        }

        #[test]
        fn a_closed_capture_cannot_restart() {
            assert_eq!(restart_decision(true, false, true, false, 0, RESTART_INTERVAL), RestartDecision::Ignore);
        }

        #[test]
        fn a_restart_inside_the_rate_limit_fails_visible() {
            assert_eq!(
                restart_decision(true, false, true, true, 1, RESTART_INTERVAL - Duration::from_millis(1)),
                RestartDecision::Fail
            );
        }

        #[test]
        fn a_session_at_the_restart_limit_fails_visible() {
            assert_eq!(restart_decision(true, false, true, true, MAX_RESTARTS, RESTART_INTERVAL), RestartDecision::Fail);
        }

        #[test]
        fn thirty_spaced_restarts_are_bounded_by_the_session_cap() {
            for completed in 0..MAX_RESTARTS {
                assert_eq!(restart_decision(true, false, true, true, completed, RESTART_INTERVAL), RestartDecision::Restart);
            }
            assert_eq!(restart_decision(true, false, true, true, MAX_RESTARTS, RESTART_INTERVAL), RestartDecision::Fail);
        }

        #[test]
        fn the_no_speech_error_is_restartable() {
            assert!(is_no_speech_error(NO_SPEECH_DOMAIN, NO_SPEECH_CODE));
            assert!(!is_no_speech_error("NSURLErrorDomain", NO_SPEECH_CODE));
            assert!(!is_no_speech_error(NO_SPEECH_DOMAIN, 1));
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
