// Fixed options for every system `ssh` and `scp` that Lume runs when its
// built-in client cannot connect. `-F /dev/null` reads neither the user's nor
// the system's ssh_config, so a host configuration cannot forward the agent,
// ports, X11, a tunnel or environment variables to the guest, run a local or
// proxy command, or share a control connection. Each option also wins over a
// configuration file by itself. Lume signs in with the guest password, so no
// host key is offered either.
//
// The guest's host key is checked, strictly, against one pin file. Upstream
// turned that check off (`StrictHostKeyChecking=no` with
// `UserKnownHostsFile=/dev/null`) while signing in with the guest password, so
// whatever answered at the guest's address was given the password and the
// session. Here ssh itself refuses, before any authentication, a host with no
// pinned key or with a key other than the pinned one. Nothing is learned on
// first use and no pin is ever written or updated by Lume: the person adds one
// (README, "Pinning a guest's host key").
import Darwin

enum TerminalXSSHPolicy {
    static let fixed = [
        "-F", "/dev/null",
        "-o", "ForwardAgent=no",
        "-o", "IdentityAgent=none",
        "-o", "ForwardX11=no",
        "-o", "ClearAllForwardings=yes",
        "-o", "Tunnel=no",
        "-o", "PermitLocalCommand=no",
        "-o", "ProxyCommand=none",
        "-o", "ProxyJump=none",
        "-o", "ControlMaster=no",
        "-o", "ControlPath=none",
        "-o", "PubkeyAuthentication=no",
        "-o", "HostbasedAuthentication=no",
        "-o", "GSSAPIAuthentication=no",
        "-o", "PKCS11Provider=none",
    ]

    /// A path no file can be created at by an unprivileged account: with it,
    /// ssh knows no host key and refuses every host.
    static let noPin = "/var/empty/terminalx-no-pinned-host-key"

    /// The pin file: `.lume/ssh_known_hosts` in `home`. ssh splits this option
    /// on spaces and expands `~` and `%` tokens in it, so a home that is not a
    /// plain absolute path gets `noPin`, and every host is refused.
    static func knownHosts(home: String?) -> String {
        guard let home, home.hasPrefix("/"), !home.hasSuffix("/"), !home.contains("//"),
              home.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
                  || [45, 46, 47, 95].contains($0) })
        else { return noPin }
        return home + "/.lume/ssh_known_hosts"
    }

    /// This account's home as the account database records it. `$HOME` is
    /// never read, so no environment variable chooses the pin file.
    static func accountHome() -> String? {
        guard let entry = getpwuid(getuid()), let directory = entry.pointee.pw_dir else { return nil }
        return String(cString: directory)
    }

    /// `fixed`, then the host key options. The pin file is the only source of
    /// host keys: no system file, DNS record, command or first-use prompt adds
    /// one, and none is updated from what a host offers.
    static func arguments(knownHosts: String) -> [String] {
        fixed + [
            "-o", "StrictHostKeyChecking=yes",
            "-o", "UserKnownHostsFile=\(knownHosts)",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "KnownHostsCommand=none",
            "-o", "UpdateHostKeys=no",
            "-o", "VerifyHostKeyDNS=no",
            "-o", "NoHostAuthenticationForLocalhost=no",
            "-o", "HostKeyAlgorithms=ssh-ed25519",
        ]
    }

    static var arguments: [String] { arguments(knownHosts: knownHosts(home: accountHome())) }
}
