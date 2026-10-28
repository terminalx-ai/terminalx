// Diagnostic-only endpoint capture. Never used by the acceptance path.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 32 * 1024 * 1024;
const stamp = () => ({ utc: new Date().toISOString(), monotonicMs: performance.now() });

/** Validate the actual footprint schema, not rounded stdout totals. */
export function footprintBytes(value, pid) {
  if (value?.unit !== "byte" || value["bytes per unit"] !== 1 ||
      !Array.isArray(value.errors) || value.errors.length ||
      !Array.isArray(value.warnings) || value.warnings.length ||
      !Array.isArray(value.processes) || value.processes.length !== 1) {
    throw new Error("footprint missing byte units, single target, or clean diagnostics");
  }
  const row = value.processes[0];
  if (row.pid !== pid || !Number.isSafeInteger(row.footprint) || row.footprint < 0) {
    throw new Error("footprint target/byte count mismatch");
  }
  return row.footprint;
}

/** ps lstart is an identity fence, not a nanosecond PID-reuse guarantee. */
export function processIdentity(text, pid) {
  const lines = text.trim().split("\n");
  const match = lines.length === 1 && /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]+\s+[A-Za-z]+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(lines[0].trim());
  if (!match || Number(match[1]) !== pid) throw new Error("missing/ambiguous process identity");
  return { pid, ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].replace(/\s+/g, " "), command: match[5] };
}

// Same existing driver responsibility API, restricted to explicit target PIDs.
// Not claimed to be a public API. Target ABI/capability qualification is required
// before using this diagnostic; there is no launchctl/sudo/private-kernel fallback.
const RESPONSIBILITY = `import ctypes,sys
f=ctypes.CDLL('/usr/lib/libSystem.B.dylib').responsibility_get_pid_responsible_for_pid
f.argtypes=[ctypes.c_int]
f.restype=ctypes.c_int
print(f(int(sys.argv[1])))
`;

/**
 * Binding is populated by separately qualified private-app ownership, never by
 * selecting every WebContent process. Targets remain fixed across all endpoints.
 * This captures raw evidence; it does not classify allocator attribution/acceptance.
 */
export function captureNativeEndpoint(directory, binding, phase) {
  if (!['open', 'tabs', 'cleanup'].includes(phase) ||
      !Number.isSafeInteger(binding?.appPid) || binding.appPid <= 1 ||
      typeof binding.appStart !== 'string' || !binding.appStart ||
      !Array.isArray(binding.webContent) || !binding.webContent.length || binding.webContent.length > 3 ||
      new Set(binding.webContent.map(x => x.pid)).size !== binding.webContent.length ||
      binding.webContent.some(x => !Number.isSafeInteger(x.pid) || x.pid <= 1 || x.pid === binding.appPid ||
        typeof x.started !== 'string' || !x.started || typeof x.command !== 'string' || !x.command.includes('com.apple.WebKit.WebContent'))) {
    throw new Error("native capture requires a qualified exact app/WebContent identity binding");
  }
  const root = join(directory, phase);
  mkdirSync(root, { mode: 0o700 }); // Existing phase refuses overwrite/retry.
  const result = { phase, started: stamp(), status: 'incomplete', binding, commands: [], samples: [] };
  const end = performance.now() + 45_000;
  function run(name, executable, args) {
    const remaining = end - performance.now();
    if (remaining <= 0) throw new Error('native endpoint deadline');
    const start = stamp();
    const r = spawnSync(executable, args, { encoding: 'utf8', timeout: Math.min(12_000, Math.ceil(remaining)),
      maxBuffer: LIMIT, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
    writeFileSync(join(root, `${name}.stdout`), r.stdout ?? '', { flag: 'wx', mode: 0o600 });
    writeFileSync(join(root, `${name}.stderr`), r.stderr ?? '', { flag: 'wx', mode: 0o600 });
    result.commands.push({ name, executable, args, pid: r.pid, start, end: stamp(), exit: r.status, signal: r.signal, error: r.error?.message });
    if (r.error || r.status !== 0 || r.signal || performance.now() >= end) throw new Error(`${name}: native capture failed`);
    return r.stdout;
  }
  function identity(pid, name) {
    return processIdentity(run(name, '/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,pgid=,lstart=,comm=']), pid);
  }
  function check(suffix) {
    const app = identity(binding.appPid, `app-${suffix}`);
    if (app.started !== binding.appStart) throw new Error('app identity changed');
    const targets = binding.webContent.map(expected => {
      const actual = identity(expected.pid, `target-${expected.pid}-${suffix}`);
      if (actual.started !== expected.started || actual.command !== expected.command) throw new Error('WebContent identity changed');
      const responsible = run(`responsibility-${expected.pid}-${suffix}`, '/usr/bin/python3', ['-B', '-c', RESPONSIBILITY, String(expected.pid)]).trim();
      if (responsible !== String(binding.appPid)) throw new Error('WebContent responsibility changed/unavailable');
      return actual;
    });
    return { app, targets };
  }
  try {
    result.before = check('before');
    // One-shot counters only; never memory_pressure allocation/simulation.
    run('vm-stat', '/usr/bin/vm_stat', []);
    run('swap-usage', '/usr/sbin/sysctl', ['vm.swapusage']);
    for (const target of binding.webContent) {
      const file = join(root, `${target.pid}.footprint.json`);
      run(`footprint-${target.pid}`, '/usr/bin/footprint', ['-p', String(target.pid), '-f', 'bytes', '--swapped', '-j', file]);
      if (statSync(file).size > LIMIT) throw new Error('footprint file exceeds evidence limit');
      const bytes = footprintBytes(JSON.parse(readFileSync(file, 'utf8')), target.pid);
      run(`vmmap-${target.pid}`, '/usr/bin/vmmap', ['-summary', String(target.pid)]);
      result.samples.push({ pid: target.pid, footprintBytes: bytes });
    }
    result.after = check('after');
    if (JSON.stringify(result.before) !== JSON.stringify(result.after)) throw new Error('endpoint identities changed');
    if (performance.now() >= end) throw new Error('native endpoint deadline');
    result.status = 'raw-capture-complete-not-attribution';
  } catch (error) {
    result.error = error.message;
  } finally {
    result.completed = stamp();
    writeFileSync(join(root, 'capture.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  }
  if (result.status === 'incomplete') throw new Error(`native endpoint incomplete; retained ${root}/capture.json`);
  return result;
}
