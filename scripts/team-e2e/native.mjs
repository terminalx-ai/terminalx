import { command, terminalxResult } from "./process.mjs";

export function desktopEnvironment({ runId, account, directory, apiOrigin }, inherited = process.env) {
  if (!/^team-[a-f0-9-]{36}$/.test(runId) || !["A", "B"].includes(account)) throw new Error("Invalid run owner");
  const url = new URL(apiOrigin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.username || url.password || url.search || url.hash || !url.port) throw new Error("Fixture API must be a loopback origin");
  if (!directory.startsWith("/") || directory === "/") throw new Error("An absolute run directory is required");
  // Do not inherit a coordinator's socket, token, provider credentials or agent homes.
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].filter((key) => inherited[key]).map((key) => [key, inherited[key]]));
  return {
    ...env,
    TERMINALX_HOME: `${directory}/${account}`,
    TERMINALX_DEV_API_BASE_URL: url.origin,
    RACCOON_DEV_KEYCHAIN_SERVICE: `dev.terminalx.${runId}.${account}`,
  };
}

/** Commands go through the controlling TerminalX app, using a PID from its live inventory. */
export function nativeObserver({ pid, run = command }) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A verified dev-app PID is required");
  let latest;
  return {
    async snapshot() {
      latest = terminalxResult(await run("terminalx", ["computer", "get-app-state", "--app", `pid:${pid}`, "--json"]));
      if (!latest.snapshot?.treeText || latest.snapshot.treeText.includes("withheld") || latest.snapshot.app?.pid !== pid) {
        latest = undefined;
        throw new Error("Native state is protected, unavailable or belongs to another PID");
      }
      return latest;
    },
    async click(index) {
      if (!latest || !Number.isSafeInteger(index) || index < 0 || !new RegExp(`^\\s*${index}(?:\\s|$)`, "m").test(latest.snapshot.treeText)) throw new Error("Read fresh native state before choosing an element");
      latest = undefined;
      // A successful click isn't an assertion. The caller must observe its effect.
      return terminalxResult(await run("terminalx", ["computer", "click", "--app", `pid:${pid}`, "--element-index", String(index), "--json"]));
    },
  };
}
