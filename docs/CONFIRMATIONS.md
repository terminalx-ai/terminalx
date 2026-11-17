# Confirmation scope

Design 17.01 uses the in-app confirmation card for ordinary app actions. The
question is the title, the consequences are described, and the safe choice is
available alongside the action. Quit is an accepted native-dialog exception
for the current scope, including when a usable app window exists. Cloud control
consent also deliberately uses a native alert so an agent driving the web view
cannot approve it.

PRO-455 owns any future change to Quit's presentation; GitHub #1182 records the
same boundary and does not create a separate routing effort. A future move to an
in-app card when a usable window exists must retain a native fallback for tray
or other quits with no usable window, and cover both routes and their failure or
dismissal behavior. Until then Quit always uses the Rust native dialogs, so a
missing, hidden, closing, or unresponsive web view cannot strand the question.

## Quit acceptance criteria

- The existing quit guard asks before interrupting work when its warning is
  pending. Only the explicit Quit Anyway choice permits that guarded quit;
  dismissal or Keep Running leaves the app running.
- When the local runtime is available and no quit behavior is saved, the
  native choice offers Quit and Keep Running, Quit and Stop All, and Cancel.
  Dismissal cancels; a chosen policy is saved. An explicit Stop all and quit
  does not overwrite the normal-quit preference.
- Stop-all must be confirmed by the runtime. If the runtime is unavailable or
  stopping fails, the app reports the error and does not quit. Repeated quit
  requests while a question is open do not open another one.
- These criteria apply whether or not a usable window exists. The existing
  platform limits remain: Dock quit, logout and shutdown can end the process
  without this guard, and update restarts are not held back.
