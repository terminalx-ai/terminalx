# Machines: work on your other computers from this Mac

With Machines, TerminalX on this Mac can operate TerminalX on another
computer: a second Mac, a Mac mini, or a Linux server with no screen. That
computer's projects and sessions appear in your sidebar, and you work in them
as you do in your own. Every session, terminal, file change and git command
runs on the other computer. Nothing is copied to this Mac.

Words used here:

- **This Mac**: the Mac you are sitting at.
- **Machine**: the other computer, the one being operated.

Open Settings → Machines to get started. TerminalX 0.2.35 makes this page
available by default.

## What you need

- TerminalX on both computers. A machine can be a Mac with the app, a Mac with
  only the runtime, or a Linux server (x64 or arm64).
- For first pairing, both a pairing code and the account list require a
  direct connection from this Mac to TCP port 6768 on the machine, on the
  same network or through [Tailscale](https://tailscale.com). Pairing by code
  works signed out.
- For account pairing with another desktop Mac or for TerminalX Relay, sign
  both computers in to the same TerminalX account. The relay can carry a
  paired connection when a direct route is unavailable.

Every path is end-to-end encrypted. The relay only passes sealed messages: it
cannot read your prompts, terminals or files.

## Add a Mac

A Mac mini, or another Mac you own.

1. **On that Mac**, open Settings → Machines and turn on **Let other
   computers operate this Mac**. It is off until you turn it on. While it is
   off, that Mac listens for no one.
2. **On this Mac**, open Settings → Machines and choose **Add a machine**.
   Then either:
   - **On your account**: if both Macs are signed in to the same TerminalX
     account, the other Mac is listed. Choose **Connect**.
   - **Pairing code**: on the other Mac, choose **Create pairing code**
     under "Computers that can operate this Mac", copy it, and paste it here.
     A code works once and lasts five minutes.
3. Both screens now show a fingerprint, such as `A21B·6E09`. Check that they
   are the same, then choose **Allow** on the other Mac. If they differ,
   choose **Decline**: you are not talking to the computer you think you are.

The Mac appears under Your machines and as a section in the sidebar, with its
projects and their sessions.

## Add a server

A Linux server, or any computer you reach only through a terminal.

1. On the server, install TerminalX:

   ```sh
   curl -fsSL https://terminalx.ai/install.sh | sh
   ```

   It checks the release's signature, installs the runtime for your user and
   starts it as a service that starts at boot. [HEADLESS-SERVER.md](HEADLESS-SERVER.md)
   has the requirements and what it installs.
2. Still on the server, make a pairing code:

   ```sh
   terminalx-serve pair
   ```

   If asked whether other computers can operate the server, answer `y`.

3. On this Mac, choose **Add a machine** → **Headless server**, and paste
   the code. Choose **Continue**, compare the fingerprint the server prints
   with the one on this Mac, and answer `y` on the server if they match.
   For later relay access, run `terminalx-serve login` on the server and sign
   this Mac in to the same account. Once the server registers with the relay,
   quit TerminalX on this Mac with **⌘Q** and reopen it while the direct route
   is still available. TerminalX requests a relay credential when it makes
   the new direct connection.
   [Server relay setup](HEADLESS-SERVER.md#how-your-computer-reaches-the-server)
4. Give the server something to work on. Either add a project from this Mac
   (open the server in Settings → Machines, then **Add a project** under
   Projects), or on the server:

   ```sh
   terminalx-serve projects add ~/your-repo
   ```

5. Sign the agents in on the server. The server's page in Settings → Machines
   lists each agent with its version and whether it is signed in. **Sign in**
   and **Install** run in a terminal on the server, shown under the agent.

## Start a session there

- In the sidebar, the **+** on a machine's section starts a session in one of
  its projects.
- In a new session, **Where it runs** lists This Mac, each machine, and your
  organizations' cloud. Choose a machine, then its project. The form shows
  that machine's branches and agents.
- When you hand a conversation over, **Runs on** lets the new session start on
  a machine.

A session belongs to the machine it was made on. It stays there; nothing moves
it to another computer.

In a session on a machine you have the chat, approvals, Changes, Checks, Files,
pull requests, forwarded ports and terminals, all on that machine. Its
terminals are named after it.

The built-in browser, computer use, dictation, Local VM, and orchestration
runs stay on the computer you sit at. Dictation on this Mac can fill a
machine session’s composer. Forwarded port previews open on this Mac.

Agents in this Mac's sessions can work on your machines too, with the
`terminalx` command line (`terminalx machines list`, `terminalx sessions create
--machine "Mac mini" …`). They reach only the machines you added here, with the
same rights this Mac has there.

## When a machine is offline

A machine can be asleep, off, or out of reach. Its section in the sidebar
stays, dimmed, with the sessions it last reported, and says when it was last
seen.

- **Its sessions keep running** on the machine. Nothing stops because this
  Mac lost sight of it.
- **You can still type** in a session there, but Send waits: the composer says
  "Can't send until Mac mini is back". Nothing is queued on this Mac; send it
  once the machine is back.
- **This Mac keeps trying**: directly first, then through the relay. When the
  machine is back, a short notice says so, and sessions that finished while it
  was away show as unread.
- **Try again** tries at once. **Disconnect**, in the machine's status
  popover, stops this Mac trying until you choose Try again.
- **Access removed** means the machine no longer lets this Mac in: someone
  revoked it there, or it went unused for 90 days. Choose **Pair again**.

The states you may see on a machine: Direct, Relay, Connecting, Reconnecting,
Offline, Needs update, Updating, Access removed and Not connected.

## Update a machine

The two computers update on their own, so they may run different versions.
Everything that works on both keeps working. When the machine is too old for
something this Mac offers, its card says **Needs update**, and what is hidden
is named where it would be ("ci-box runs TerminalX 0.2.27. Update it to forward
ports from here.").

- Choose **Update** on the machine's card or its page. TerminalX on the
  machine updates itself; sessions running there keep going through the
  update. Sessions that would be stopped are listed first.
- If this Mac is the older one, the machine's page says so: update this Mac
  instead.
- A server installed with the install script can also be updated on the
  server with `terminalx-serve update`.

## Remove a machine

On this Mac, open Settings → Machines, open the machine's **⋯** menu and choose
**Remove from this Mac**. Its section leaves the sidebar and this Mac forgets
its credential. Nothing on the machine is changed or deleted, and its sessions
keep running there. Adding it again needs a new pairing.

To end the access from the machine's side instead, open Settings → Machines on
it and choose **Revoke** beside this Mac under "Computers that can operate this
Mac", or on a server run `terminalx-serve devices revoke`. To take TerminalX
off a server altogether, run `terminalx-serve service uninstall` there.

## Let other computers operate this Mac

The switch at the top of Settings → Machines decides whether other computers
can operate this Mac. It is off by default. While it is off, this Mac opens no
listener and registers nothing with the relay.

When it is on:

- Each computer you allow has its own credential, listed under "Computers that
  can operate this Mac" with how it is connected.
- **Disconnect** closes a computer's connection and keeps it out until you
  choose **Let back**. **Revoke** ends its credential for good.
- The activity log below the list shows what each computer did here: when it
  paired and connected, and when it started a session or opened a terminal,
  with the project's name. It never records prompts, commands, file contents
  or paths.

A computer you allow can do here what you can: start sessions, open terminals,
change files. Allow only computers you own.

### Where this Mac listens

**Where it listens** decides which addresses this Mac opens for paired
computers and phones (TCP port 6768). It shows whether or not the switch is
on, since your phones use the same addresses:

- **Relay only**: no port. They reach this Mac through the TerminalX relay,
  end-to-end encrypted. Turning the switch on for the first time chooses it
  when you are signed in and nothing is paired yet. Signed out, there is no
  relay, so it chooses **Local network** instead. With a phone or computer
  already paired, nothing changes until you choose. Sharing a session through
  the relay works under Relay only; a local-network-only share needs another
  choice.
- **Tailscale**: this Mac's Tailscale address only.
- **Local network**: its private network and Tailscale addresses.
- **All interfaces**: every address, public ones included.

Whatever you choose, a connection that comes from a public address is refused
unless you tick **Answer callers from public addresses** under All
interfaces. A Mac that was already operated before this setting existed keeps
listening as it did; if it has a public address, the page asks once whether to
keep it or close it. The same block says which user TerminalX runs as. A
paired machine's page (Settings → Machines → the machine) shows the same for
that machine under **Listening and privileges**, and a computer that manages
it can change where it listens from there.

## Data privacy mode

Data privacy mode turns Machines off on this Mac in both directions: no other
computer can operate it, and it operates no machine. Settings → Machines says
so. Your machines and the computers you allowed stay paired for when it is off.
