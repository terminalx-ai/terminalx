// Fixed options for every system `ssh` and `scp` that Lume runs when its
// built-in client cannot connect. `-F /dev/null` reads neither the user's nor
// the system's ssh_config, so a host configuration cannot forward the agent,
// ports, X11, a tunnel or environment variables to the guest, run a local or
// proxy command, or share a control connection. Each option also wins over a
// configuration file by itself. Lume signs in with the guest password, so no
// host key is offered either.
enum TerminalXSSHPolicy {
    static let arguments = [
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
}
