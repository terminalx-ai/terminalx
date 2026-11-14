import { spawn } from "node:child_process";

/** Bound only the child we created. Never search for or kill host processes by name. */
export function command(executable, args, { timeoutMs = 10_000, input, env = process.env, cwd, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    const chunks = { stdout: [], stderr: [] };
    let size = 0;
    let error;
    let killTimer;
    const stop = (reason) => {
      if (error) return;
      error = new Error(reason);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => stop("command_timeout"), timeoutMs);
    for (const name of ["stdout", "stderr"]) child[name].on("data", (data) => {
      size += data.length;
      if (size > maxBytes) stop("command_output_limit");
      else chunks[name].push(data);
    });
    child.on("error", (failure) => { clearTimeout(timer); clearTimeout(killTimer); reject(failure); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      const result = { code, signal, pid: child.pid, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() };
      if (error) { error.result = result; reject(error); }
      else resolve(result);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** The CLI envelope, not its exit status alone, decides whether an operation succeeded. */
export function terminalxResult(result) {
  if (result.code !== 0) throw new Error(`terminalx_exit_${result.code}`);
  const envelope = JSON.parse(result.stdout);
  if (envelope.ok !== true) throw new Error(`terminalx_${envelope.error?.code ?? "invalid_response"}`);
  return envelope.result;
}
