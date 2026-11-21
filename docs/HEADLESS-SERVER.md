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
- No root needed. TerminalX installs into the home directory of the user who
  runs the installer and runs as that user. Nothing in install, update or
  pairing asks for `sudo`; the one command that does is yours to run
  (`loginctl enable-linger`, below). Root may install and run it, with a
  warning: see [Which user to run as](#which-user-to-run-as).
- **Linux:** a systemd user session. To keep the runtime running after you log
  out, and to start it at boot, turn on lingering once:
  `sudo loginctl enable-linger "$USER"`.
- **macOS:** the runtime runs as a LaunchAgent, which starts when you log in.
  You must stay logged in (with automatic login, or a session left open).
- TerminalX on the computer you will operate the server from.

## Install

Log in to the server as the user who will run the agents (see
[Which user to run as](#which-user-to-run-as)), and run:

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

The installer ends with the two commands to run next, `login` and `pair`,
written so they work as printed: by name when `~/.local/bin` is on your
`PATH`, by full path (`~/.terminalx/current/terminalx-serve`) when it is not.
In that case it also says how to add it:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile && . ~/.profile
```

(or `~/.bashrc` or `~/.zshrc`, whichever your shell reads). Until then,
`~/.terminalx/current/terminalx-serve` works everywhere `terminalx-serve` is
written below.

Check the service with `terminalx-serve service status`. It says whether the
service runs, where the server listens, and which user it runs as:

```text
Listening  Relay only: no port is open
           (`terminalx-serve hosting --listen relay|tailscale|lan|all` changes it)
Runs as    dev
Sudo       dev has no passwordless sudo
```

## Which user to run as

The runtime runs as the user who installed it. **Every paired computer and
every agent on the server acts as that user**: a paired computer has a shell
there, and so does each agent. The installer never creates a user or
switches to another one; you choose by logging in as the user you want before
you run it. Three set-ups:

- **A disposable VM** (one you create for a task and delete): a dedicated
  user with passwordless `sudo`, as cloud images set up by default (`ubuntu`,
  `ec2-user`). Agents can install packages and change the system, which is
  the point of such a VM; anything they break goes away with it. Running as
  root there comes to the same thing.
- **A shared or long-lived server:** a dedicated user with **no** `sudo`, or
  `sudo` limited to named commands in `/etc/sudoers.d`
  (`dev ALL=(root) NOPASSWD: /usr/bin/systemctl restart myapp`). Agents then
  cannot read other users' files or change the system. Mind the `docker`
  group: a member can start a container that mounts the host's disk as root,
  so membership is passwordless root in practice. Add the user to it only if
  you would also give it `sudo`; rootless Docker or Podman avoids this.
- **Your own machine** (a workstation, a Mac mini under your desk): your own
  user, as for the desktop app. Agents work with your files, as you do.

Root is allowed. The installer and `terminalx-serve service install` print a
warning that every paired computer and every agent on the server will act as
root, and carry on; the runtime logs the same warning each time it starts.
`terminalx-serve service status` and the server's page on your computer
(Settings → Machines → the server) say that it runs as root, and for any
other user whether it has passwordless `sudo`.

## Pair it with your computer

On the server, in a terminal you typed into yourself (not a TerminalX session
or an agent), run:

```sh
terminalx-serve pair
```

The first time, it asks where the server should listen (below); Enter takes
the default, **Relay only**. It then shows a one-time code. On your computer,
open TerminalX → **Settings → Machines → Add a machine → Headless server**
and enter the code. The server's
terminal then names your computer, shows a fingerprint, and asks
`Allow? [y/N]`. Check that the fingerprint matches the one on your computer,
then type `y`. Anything else, or no answer, declines.

Pairing turns on "Let other computers operate this one" on the server. The
server then appears under Machines on your computer, with its projects.

### Where the server listens

| Choice | What it opens | Use it when |
| --- | --- | --- |
| **Relay only** (default) | No port. Your computer and phone reach the server through the TerminalX relay, end-to-end encrypted. | The server has a public address, or you do not want to think about firewalls. Needs `terminalx-serve login`. |
| **Tailscale** | TCP 6768 on the server's Tailscale address only. | Your computer is on the same tailnet. |
| **Local network** | TCP 6768 on its private (10.x, 172.16–31.x, 192.168.x) and Tailscale addresses. | Your computer is on the same network. |
| **All interfaces** | TCP 6768 on every address, public ones included. | You front it with your own firewall. Never the default: you choose it in so many words. |

`terminalx-serve pair` asks the first time, naming this server's addresses of
each kind. Change it later, with no restart:

```sh
terminalx-serve hosting --listen lan
terminalx-serve hosting                 # what it is now
```

Whatever the choice, a connection **from** a public address is refused, even
under All interfaces, unless you add `--allow-public`
(`terminalx-serve hosting --listen all --allow-public`). The first refusal in
each hour is written to the log. The phone listener follows the same setting,
and the addresses a pairing code or QR code carries are only those the server
is listening on.

**A server installed before this setting existed** keeps listening as it did
until you choose. If it has a public address, or a caller from one reaches
it, it refuses those callers from the update on and asks once: `service
status` and its page on your computer say so, with the two answers
(`hosting --listen all --allow-public` keeps the public address;
`--listen relay`, `tailscale` or `lan` closes it). Meanwhile it stays
reachable through the relay and your private networks. A server that was
reached only over its public address and never signed in is brought back
over SSH: run `terminalx-serve login`, or the `hosting` command above.

### How your computer reaches the server

- **Relay (the default):** sign the server in to the same TerminalX account as
  your computer, before or after `pair`:

  ```sh
  terminalx-serve login
  ```

  It prints a link. Open it on any device where you are signed in to
  TerminalX, check that it shows the same code as the server's terminal, and
  approve. The service log (`~/.terminalx/logs/runtime.log`) then says
  `machine host: registered with the relay`. A code made after that carries
  a single-use relay invite, so **the first pairing itself goes through the
  relay**, with no port open on the server. Your computer must be signed in
  to TerminalX too; if it is not, Add a machine says so. `pair` on a
  Relay-only server that has not signed in tells you to run `login` first.
- **Same network or Tailscale:** with **Tailscale** or **Local network**
  chosen, pairing by code needs no account. Your computer connects to the
  server directly (TCP port 6768), so that port must be reachable from it.
  Signed in as well, the server is reached directly when it can be and
  through the relay otherwise; the sidebar says **Direct** or **Relay**.

  The server keeps its sign-in session in
  `~/.terminalx/data/account/session.json`, readable by its user only.
  `terminalx-serve logout` signs the server out again. The relay carries
  end-to-end encrypted traffic.

  Signing out also removes the server from your account's machines. If
  that step fails (no network, the account service is down), the server is
  already signed out locally and `terminalx-serve logout` finishes the
  removal when you run it again; `login` waits until it has. If the
  account service has ended the saved session (it expired or was revoked),
  no retry can finish, and `logout` says so. Run
  `terminalx-serve logout --forget-ended` to delete the saved session
  anyway. The account service is not told, so the server stays listed
  under that account: `login` reminds you, signing in as the same account
  takes the entry over again, and another account can be refused until it
  is removed there. `--forget-ended` does nothing more than a plain
  `logout` while the removal can still succeed.

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
- **Add a machine cannot reach the server:** run `terminalx-serve service
  status` there. With **Relay only** the server must be signed in (`login`)
  and so must your computer; with another choice, your computer must reach
  one of the addresses it lists on TCP 6768.
- **"callers from public addresses are refused":** see
  [Where the server listens](#where-the-server-listens).
- The service's log is `~/.terminalx/logs/runtime.log`.
