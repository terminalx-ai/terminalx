# Confirmation scope

Design 17.01 uses the in-app confirmation card for ordinary app actions. The
question is the title, the consequences are described, and the safe choice is
available alongside the action. Quit uses the same card when the main window
is visible and can receive the question. Rust asks with a native alert if the
window is missing, hidden, or minimized, or if its web view stops responding
before Rust receives an answer. Cloud control consent uses a native alert so
an agent driving the web view cannot approve it.

## Quit acceptance criteria

- The existing quit guard asks before interrupting work when its warning is
  pending. Only the explicit Quit Anyway choice permits that guarded quit;
  dismissal or Keep Running leaves the app running. The design's Quit when
  idle option is outside the scope of PRO-455.
- When the local runtime is available and no quit behavior is saved, the
  prompt offers Quit and Keep Running, Quit and Stop All, and Cancel.
  Dismissal cancels; a chosen policy is saved. An explicit Stop all and quit
  does not overwrite the normal-quit preference.
- Stop-all must be confirmed by the runtime. If the runtime is unavailable or
  stopping fails, the app reports the error and does not quit. Repeated quit
  requests while a question is open do not open another one.
- These criteria apply whether or not a usable window exists. The existing
  platform limits remain: Dock quit, logout and shutdown can end the process
  without this guard, and update restarts are not held back.
