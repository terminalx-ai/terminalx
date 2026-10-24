//! The local macOS owner's menu-bar UI. This feature is excluded from cloud
//! builds. One owner owns one tray item through window attach/detach and updates.
use std::cell::OnceCell;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use anyhow::{bail, Context, Result};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol, NSString, NSTimer, NSPoint};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate, NSApplicationTerminateReply, NSStatusBar, NSStatusItem, NSMenu, NSMenuItem, NSAlert, NSEvent, NSEventType, NSEventModifierFlags};
use serde_json::json;
use crate::session::SessionManager;
use crate::sink::EventSink;
use super::Lifetime;

#[derive(Clone)]
struct ContextState { manager: SessionManager, lifetime: Arc<Lifetime> }
struct Shared {
    context: Mutex<Option<ContextState>>,
    done: AtomicBool,
    terminating: AtomicBool,
    action: AtomicBool,
    errors: Mutex<VecDeque<String>>,
    application: String,
    counts: Mutex<Option<(std::time::Instant,usize,usize,bool)>>,
}
static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

pub(crate) fn running() -> bool { SHARED.get().is_some() }
pub(crate) fn shutdown_requested() -> bool { SHARED.get().is_some_and(|shared|shared.terminating.load(Ordering::SeqCst)) }

/// Only the native desktop launcher opts into AppKit. Hook/credential helper
/// modes return before this entry point, and cloud/default serve stays headless.
pub(crate) fn run(work: impl FnOnce() -> Result<()> + Send + 'static) -> Result<()> {
    let mtm = MainThreadMarker::new().context("The local runtime UI requires the main thread.")?;
    let application = std::env::var("TERMINALX_LOCAL_APPLICATION").context("The desktop application identifier is missing.")?;
    if application.len() > 255 || !application.contains('.') || !application.bytes().all(|c|c.is_ascii_alphanumeric() || matches!(c,b'.'|b'-')) {
        bail!("The desktop application identifier is invalid.");
    }
    let shared = Arc::new(Shared { context:Mutex::new(None),done:AtomicBool::new(false),terminating:AtomicBool::new(false),action:AtomicBool::new(false),errors:Mutex::new(VecDeque::new()),counts:Mutex::new(None),application });
    SHARED.set(shared.clone()).map_err(|_|anyhow::anyhow!("The runtime UI already started."))?;
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    let controller = Controller::new(mtm,shared.clone());
    app.setDelegate(Some(ProtocolObject::from_ref(&*controller)));
    // SAFETY: Controller implements tick: with the NSTimer selector signature;
    // the scheduled timer retains its target until it is invalidated below.
    let timer = unsafe { NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(0.25,&controller,sel!(tick:),None,true) };
    let worker = std::thread::Builder::new().name("local-runtime".into()).spawn(move || {
        // Always wake AppKit on unwind as well as normal shutdown. Otherwise a
        // failed runtime thread would leave a misleading, inert tray behind.
        struct Finished(Arc<Shared>);
        impl Drop for Finished {
            fn drop(&mut self) { self.0.done.store(true,Ordering::SeqCst); }
        }
        let _finished = Finished(shared);
        work()
    })?;
    app.run();
    timer.invalidate();
    worker.join().map_err(|_|anyhow::anyhow!("The local runtime worker panicked."))?
}

pub(crate) fn install(manager: &SessionManager, lifetime: &Arc<Lifetime>, sink: &Arc<dyn EventSink>) {
    let Some(shared) = SHARED.get() else { return };
    *shared.context.lock().unwrap() = Some(ContextState {manager:manager.clone(),lifetime:lifetime.clone()});
    // Provider locks must never block the menu-bar run loop. A delayed sample
    // is displayed as unavailable rather than a stale count of running work.
    let counted = shared.clone();
    let counted_manager = manager.clone();
    let counted_lifetime = lifetime.clone();
    std::thread::spawn(move || {
        while !counted.done.load(Ordering::SeqCst) {
            let agents = counted_manager.running_tabs();
            let working = agents.iter().filter(|agent|matches!(agent.status,crate::store::index::TabStatus::InProgress|crate::store::index::TabStatus::Waiting)).count();
            let shells = counted_manager.terminals().shells().iter().filter(|shell|!shell.exited).count();
            let available = counted_lifetime.window.available();
            *counted.counts.lock().unwrap() = Some((std::time::Instant::now(),working,shells,available));
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
    // This is the same notification backend and application identity used by
    // the desktop plugin. macOS remains responsible for notification permission.
    if let Err(error) = notify_rust::set_application(&shared.application) { log::warn!("background notification identity: {error}"); }
    let (sender,receiver) = std::sync::mpsc::sync_channel::<(String,String,&'static str)>(64);
    let notification_lifetime = lifetime.clone();
    std::thread::spawn(move || {
        for (session_id,tab_id,title) in receiver {
            if notification_lifetime.window.available() || !crate::store::settings::load().notifications { continue; }
            let Ok(session) = crate::store::index::get(&session_id) else { continue };
            let Some(tab) = session.tab(&tab_id) else { continue };
            let Ok(layouts) = crate::store::index::tab_state() else { continue };
            let key = format!("agent:{tab_id}");
            let followed = tab.follow.pane.as_ref().map(|pane|format!("terminal:{pane}"));
            if layouts.workspaces.values().any(|layout|layout.muted.contains(&key) || followed.as_ref().is_some_and(|key|layout.muted.contains(key))) { continue; }
            let body = format!("{} — {}",session.title,tab.title.as_deref().unwrap_or("Agent"));
            if let Err(error) = notify_rust::Notification::new().summary(title).body(&body).show() {
                log::warn!("background notification delivery: {error}");
            }
        }
    });
    sink.listen("agent_event",Box::new(move |payload| {
        // Event emitters may hold provider, sharing and attachment locks. Never
        // inspect the window or stores synchronously inside their callback.
        let Ok(event) = serde_json::from_str::<crate::events::AgentEvent>(payload) else { return };
        let title = match event.payload {
            crate::events::Payload::TurnCompleted { .. } => "Agent finished",
            crate::events::Payload::PermissionRequested { .. } | crate::events::Payload::QuestionsAsked { .. } => "Agent needs you",
            _ => return,
        };
        if sender.try_send((event.session_id,event.tab_id,title)).is_err() { log::warn!("background notification queue is full or unavailable"); }
    }));
}

#[derive(Clone, Copy)]
enum Action { Open, Quick, Quit, Stop }
impl Shared {
    fn act(self: &Arc<Self>, action: Action) {
        if self.action.swap(true,Ordering::SeqCst) { return; }
        let shared = self.clone();
        std::thread::spawn(move || {
            if let Err(error) = shared.perform(action) {
                let mut errors = shared.errors.lock().unwrap();
                if errors.len() < 8 { errors.push_back(format!("{error:#}")); }
            }
            shared.action.store(false,Ordering::SeqCst);
        });
    }
    fn perform(&self, action: Action) -> Result<()> {
        let context = self.context.lock().unwrap().clone().context("The runtime is still starting.")?;
        let available = context.lifetime.window.available();
        if !available && matches!(action,Action::Open|Action::Quick) {
            let status = std::process::Command::new("/usr/bin/open").args(["-b",&self.application]).status()?;
            if !status.success() { bail!("TerminalX could not be opened. Its background work is still running."); }
            if matches!(action,Action::Open) { return Ok(()); }
            let until = std::time::Instant::now()+std::time::Duration::from_secs(15);
            while !context.lifetime.window.available() {
                if std::time::Instant::now()>=until { bail!("TerminalX has not attached yet. Open Quick Chat from the window."); }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        if !available && matches!(action,Action::Stop) {
            let _request = context.lifetime.enter_command(true).map_err(|error|anyhow::anyhow!(error.message))?;
            context.lifetime.command("runtime.stopAll",json!({"epoch":context.lifetime.status()["epoch"]}))
                .map_err(|error|anyhow::anyhow!(error.message))?;
            if let Err(error) = context.manager.stop_all_confirmed() { context.lifetime.stop_failed(); return Err(error); }
            return Ok(());
        }
        let command = match action { Action::Open=>"window.open",Action::Quick=>"floating.show",Action::Quit=>"window.quit",Action::Stop=>"window.stopAllAndQuit" };
        context.lifetime.window.call(command,json!({})).map_err(|error|anyhow::anyhow!(error.message))?;
        Ok(())
    }
}

struct Ivars {
    shared: Arc<Shared>,
    item: OnceCell<Retained<NSStatusItem>>,
    menu: OnceCell<Retained<NSMenu>>,
    quit: OnceCell<Retained<NSMenuItem>>,
    stop: OnceCell<Retained<NSMenuItem>>,
}
define_class!(
    // SAFETY: NSObject has no subclassing requirements; this class is main-thread-only.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct Controller;
    unsafe impl NSObjectProtocol for Controller {}
    unsafe impl NSApplicationDelegate for Controller {
        #[unsafe(method(applicationShouldTerminate:))]
        fn application_should_terminate(&self, _application: &NSApplication) -> NSApplicationTerminateReply {
            // Log-out is a real runtime shutdown, unlike closing its desktop
            // client. Let the worker record interruption and stop its children.
            self.ivars().shared.terminating.store(true,Ordering::SeqCst);
            NSApplicationTerminateReply::TerminateLater
        }
    }
    impl Controller {
        #[unsafe(method(open:))]
        fn open(&self,_sender:&NSMenuItem) { self.ivars().shared.act(Action::Open); }
        #[unsafe(method(quick:))]
        fn quick(&self,_sender:&NSMenuItem) { self.ivars().shared.act(Action::Quick); }
        #[unsafe(method(quit:))]
        fn quit(&self,_sender:&NSMenuItem) { self.ivars().shared.act(Action::Quit); }
        #[unsafe(method(stop:))]
        fn stop(&self,_sender:&NSMenuItem) { self.ivars().shared.act(Action::Stop); }
        #[unsafe(method(tick:))]
        fn tick(&self,_timer:&NSTimer) { self.refresh(); }
    }
);
impl Controller {
    fn new(mtm:MainThreadMarker,shared:Arc<Shared>) -> Retained<Self> {
        let object = Self::alloc(mtm).set_ivars(Ivars {shared,item:OnceCell::new(),menu:OnceCell::new(),quit:OnceCell::new(),stop:OnceCell::new()});
        // SAFETY: NSObject's init method has this signature.
        unsafe { msg_send![super(object),init] }
    }
    fn install(&self) {
        let mtm = self.mtm();
        let item = NSStatusBar::systemStatusBar().statusItemWithLength(-1.0);
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        for (title,action) in [("Quick Chat",sel!(quick:)),("Open TerminalX",sel!(open:)),("Stop all",sel!(stop:)),("Quit TerminalX",sel!(quit:))] {
            // SAFETY: All selectors are defined on this retained controller;
            // the controller outlives the menu and its unretained targets.
            let entry = unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(NSMenuItem::alloc(mtm),&NSString::from_str(title),Some(action),&NSString::from_str("")) };
            unsafe { entry.setTarget(Some(self)) };
            if title=="Quit TerminalX" { let _=self.ivars().quit.set(entry.clone()); }
            if title=="Stop all" { let _=self.ivars().stop.set(entry.clone()); }
            menu.addItem(&entry);
        }
        item.setMenu(Some(&menu));
        let _=self.ivars().item.set(item);
        let _=self.ivars().menu.set(menu);
        self.refresh();
    }
    fn refresh(&self) {
        let shared=&self.ivars().shared;
        if shared.done.load(Ordering::SeqCst) {
            let app = NSApplication::sharedApplication(self.mtm());
            if shared.terminating.load(Ordering::SeqCst) { app.replyToApplicationShouldTerminate(true); }
            app.stop(None);
            // stop: only takes effect after AppKit dispatches an NSEvent. This
            // callback is an NSTimer, so an idle menu-bar process otherwise
            // stays in nextEvent forever with its backend already stopped.
            // A private application event wakes the loop without user input.
            if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                NSEventType::ApplicationDefined, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(), 0.0, 0, None, 0, 0, 0,
            ) {
                app.postEvent_atStart(&event, true);
            }
            return;
        }
        // Publish an item only after this process acquired runtime ownership.
        // A second helper that loses the singleton race never installs a tray.
        if self.ivars().item.get().is_none() {
            let ready = shared.context.lock().unwrap().is_some();
            if ready { self.install(); }
            return;
        }
        let (title,available)=match *shared.counts.lock().unwrap() {
            Some((sampled,working,shells,available)) if sampled.elapsed() < std::time::Duration::from_secs(2) => (format!("TX {working} · {shells}"),available),
            _ => ("TX unavailable".into(),false),
        };
        if let Some(button)=self.ivars().item.get().and_then(|item|item.button(self.mtm())) {
            button.setTitle(&NSString::from_str(&title));
            button.setToolTip(Some(&NSString::from_str("TerminalX: working agents · open terminals")));
        }
        if let Some(quit)=self.ivars().quit.get() { quit.setHidden(!available); }
        if let Some(stop)=self.ivars().stop.get() { stop.setTitle(&NSString::from_str(if available {"Stop all and quit"} else {"Stop all"})); }
        let error=shared.errors.lock().unwrap().pop_front();
        if let Some(error)=error {
            let alert=NSAlert::new(self.mtm());
            alert.setMessageText(&NSString::from_str("TerminalX"));
            alert.setInformativeText(&NSString::from_str(&error));
            alert.runModal();
        }
    }
}
