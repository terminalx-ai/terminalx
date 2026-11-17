"""Loaded after the installer helpers and run as root by exact-ID exec (#978).

seal: stores the host's verified artifact, delivered on stdin, as the sealed
runtime. Root never reads a file the guest account can write.

rpc: proves the sealed inode still holds the digest the host expects, drops to
the dedicated account and executes that same descriptor. This process never
reads stdin, so the host key stays in the pipe until the verified runtime
reads it; on any refusal it is never read at all.
"""
import base64

ACCOUNT = OWNER


def runtime_main(argv, stdin, execute=os.execve, drop=drop_to_account):
    require(len(argv) == 1 and len(argv[0]) <= 4096, "Bounded runtime envelope required")
    header = json.loads(base64.b64decode(argv[0], validate=True))
    expected = header.get("runtimeSha256")
    require(isinstance(expected, str) and len(expected) == 64
            and all(c in "0123456789abcdef" for c in expected), "Verified runtime digest required")
    require(os.geteuid() == SEALED_OWNER, "The sealed runtime is managed as root")
    if header.get("action") == "seal":
        require(set(header) == {"action", "runtimeSha256", "bytes"} and isinstance(header["bytes"], int)
                and 64 <= header["bytes"] <= LIMIT, "Unknown seal fields")
        data = stdin.read(header["bytes"] + 1)
        require(len(data) == header["bytes"], "Incomplete or oversized artifact input")
        return {"status": seal(data, expected), "path": str(SEALED), "runtimeSha256": expected}
    require(header.get("action") == "rpc" and set(header) == {"action", "runtimeSha256"},
            "Unknown runtime action")
    fd = open_sealed(expected)
    try:
        entry = drop()
        os.chdir(entry.pw_dir)
        env = {"HOME": entry.pw_dir, "USER": ACCOUNT, "LOGNAME": ACCOUNT,
               "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        # Execute the same verified inode after the irreversible owner privilege drop.
        execute(fd, [str(SEALED), "local-vm-rpc", "-"], env)
        raise ValueError("Sealed runtime did not execute")
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": runtime_main(sys.argv[1:], sys.stdin.buffer)},
                         separators=(",", ":")))
    except Exception as error:
        # Exit 0, like `local-vm-rpc`: the host reads this refusal's reason
        # from the reply, where a failing exit would replace it with a generic one.
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
