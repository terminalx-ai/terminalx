# Run TerminalX on a headless server

A Linux server, or a Mac with no one at the screen, can run the TerminalX
runtime (`terminalx-serve`) without the desktop app. Once it is paired, you
open its projects and start Claude Code or Codex sessions on it from TerminalX
on your own computer, as you would on your own machine.

It takes about five minutes: install, pair, start a session.

## Requirements

- **Linux** on x86-64 or arm64, with glibc 2.35 or later: Ubuntu 22.04 or
  later, Debian 12, or another distribution as recent. Or **macOS** on Apple
  silicon. Intel Macs are not supported.
- `curl`, and OpenSSH 8.1 or later (`ssh-keygen` checks the release
  signature). Ubuntu and macOS have both. On a minimal image:
  `sudo apt install curl openssh-client`.
- No root. TerminalX installs into your home directory and runs as you.
- **Linux:** a systemd user session. To keep the runtime running after you log
  out, and to start it at boot, turn on lingering once:
  `sudo loginctl enable-linger "$USER"`.
- **macOS:** the runtime runs as a LaunchAgent, which starts when you log in.
  You must stay logged in (with automatic login, or a session left open).
- TerminalX on the computer you will operate the server from.

## Install

Log in to the server as the user who will run the agents, and run:

```sh
curl -fsSL https://terminalx.ai/install.sh | sh
```

The installer:

1. picks the build for this machine (Linux x86-64 or arm64, or macOS on Apple
   silicon);
2. finds the newest signed TerminalX runtime release;
3. checks the release's signature with `ssh-keygen` against the TerminalX
   release key built into the installer, and the binary's SHA-256 against the
   signed list. A download that does not verify is refused, and nothing is
   installed or changed;
4. installs it under `~/.terminalx` and links `~/.local/bin/terminalx-serve`;
5. installs and starts the user service (`terminalx-serve service install`).

```text
~/.terminalx/
  versions/<version>/terminalx-serve   each installed version
  current -> versions/<version>        the version that runs
  data/                                sessions, settings and keys
  logs/runtime.log                     the service's log
```

If the installer says `~/.local/bin` is not on your `PATH`, add it:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile && . ~/.profile
```

(or `~/.bashrc` or `~/.zshrc`, whichever your shell reads). Until then,
`~/.terminalx/current/terminalx-serve` works everywhere `terminalx-serve` is
written below.

Check the service with `terminalx-serve service status`.

## Pair it with your computer

On the server, in a terminal you typed into yourself (not a TerminalX session
or an agent), run:

```sh
terminalx-serve pair
```

It shows a one-time code. On your computer, open TerminalX → **Settings →
Machines → Add a machine → Headless server** and enter the code. The server's
terminal then names your computer, shows a fingerprint, and asks
`Allow? [y/N]`. Check that the fingerprint matches the one on your computer,
then type `y`. Anything else, or no answer, declines.

Pairing turns on "Let other computers operate this one" on the server. The
server then appears under Machines on your computer, with its projects.

### How your computer reaches the server

- **Same network or Tailscale:** pairing by code needs nothing else. Your
  computer connects to the server directly (TCP port 6768), so that port must
  be reachable from your computer: on the same network, over Tailscale, or
  through your firewall.
- **Relay after pairing:** once the server is paired, sign it in to the same
  TerminalX account as your Mac to reconnect without an inbound port:

  ```sh
  terminalx-serve login
  ```

  It prints a link. Open it on any device where you are signed in to
  TerminalX, check that it shows the same code as the server's terminal, and
  approve. Keep the direct route available until the server's service log
  (`~/.terminalx/logs/runtime.log`) says `machine host: registered with the relay`.
  On your Mac, select the server in the sidebar and open the connection
  status in its header. Choose **Disconnect**, then reopen the status and
  choose **Try again**. During this direct reconnect, the Mac requests its
  relay credential. You can then reach the server over the relay when the
  direct route is unavailable.

  The server keeps its sign-in session in
  `~/.terminalx/data/account/session.json`, readable by you only.
  `terminalx-serve logout` signs the server out again. The relay carries
  end-to-end encrypted traffic.

## Add a project

Sessions run in a project: a folder on the server, usually a Git clone. Add
one on the server:

```sh
git clone https://github.com/you/your-repo.git ~/your-repo
terminalx-serve projects add ~/your-repo
terminalx-serve projects            # lists them
```

Paired computers see it at once.

## Sign in the agents on the server

Sessions on the server run the agents installed on the server, signed in with
their own accounts there. Install them on the server and sign in to each once,
in a terminal on the server:

```sh
# Claude Code
curl -fsSL https://claude.ai/install.sh | bash
claude          # follow the sign-in prompts, then exit

# Codex
npm install -g @openai/codex
codex login --device-auth
```

Both give you a link to open in a browser on your computer, so this works over
SSH. After that,
start a session on the server from TerminalX as you would locally. (A later
version signs the agents in from the machine's page in TerminalX.)

## Pair your phone

```sh
terminalx-serve pair --phone
```

It shows a QR code. In TerminalX on your phone, open Machines → Add and scan
it, or paste the link printed under it. The phone shows a fingerprint: check
that it matches the one in your terminal, then answer `y`. The server then
appears in the phone's Machines list with a server icon. The phone reaches it
on the addresses shown, so it must be on the same network or Tailscale.

## Paired computers and phones

```sh
terminalx-serve devices               # the computers and phones that may operate this one
terminalx-serve devices revoke <id>   # remove one; it must pair again
```

## Update

```sh
terminalx-serve update
```

(or `terminalx-serve update --check` to only look) installs the newest signed
runtime release, checked the same way as the installer checks it, into a new
`~/.terminalx/versions/<version>`, and then:

1. starts it on its own, on a scratch data directory, to check that it runs
   (up to a minute). One that does not start is removed and nothing changes;
2. hands the running runtime over to it in place: its agents and terminals
   keep running, and nothing is restarted;
3. waits for the runtime to answer as the new version (up to 90 seconds), and
   only then switches `~/.terminalx/current` to it. If it does not come up,
   `current` stays on the old version and the service is restarted on it; the
   update says so, and that its agents and terminals restarted;
4. keeps `current` and the two versions before it, and removes older ones (in
   `~/.terminalx/versions` and the runtime copies in the data directory). No
   more than three versions stay on disk, and never the one running.

If the runtime runs something an update cannot carry over, it says what and
keeps the old version running; run `terminalx-serve update` again once that is
done. Running the install command again does the same.

A computer that operates this server can update it too: its machine page
offers "Update" when a newer runtime is out (once both sides run a TerminalX
that can). It names the work an update would stop and the other computers
connected, and asks first. Progress goes to
`~/.terminalx/data/run/machine-update.json`, and the helper that does the work
logs to `~/.terminalx/data/run/machine-update.log`.

## Remove

```sh
terminalx-serve service uninstall
rm -rf ~/.terminalx ~/.local/bin/terminalx-serve
```

This stops the service, removes it, and deletes the runtime and its data,
including its sessions and the list of paired computers. On your computer,
remove the machine from Settings → Machines. If you turned on lingering only
for TerminalX, `sudo loginctl disable-linger "$USER"` turns it off.

## Troubleshooting

- **"no signed TerminalX runtime release … was found"**: no release has been
  signed yet, or GitHub's API limit for your address was reached. Try again
  later.
- **"… does not verify" or "does not match its signed SHA-256"**: the download
  was not what TerminalX released. Nothing was installed. Run the installer
  again; if it keeps failing, report it.
- **"does not run on this machine"**: the server's glibc is older than 2.35.
  Use Ubuntu 22.04 or later.
- **The service does not start at boot (Linux):** turn on lingering (see
  Requirements), then run `terminalx-serve service install` again.
- The service's log is `~/.terminalx/logs/runtime.log`.
