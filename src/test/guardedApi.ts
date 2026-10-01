/**
 * A Tauri `invoke` for cloud tests that refuses every local path API
 * (PRO-23 rule 3): any call with a path-like argument, and any command that
 * is not a cloud one or explicitly allowed, throws and is recorded. Errors
 * inside components are often caught and shown, so a test asserts
 * `violations` is empty rather than relying on the throw.
 */
export const LOCAL_PATH_ARGS = ["cwd", "path", "root", "projectPath", "from", "to", "dir", "file"] as const;

export class LocalApiCalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalApiCalledError";
  }
}

export type Handler = (args: Record<string, unknown>) => unknown;

export interface GuardedApi {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Every local call that was refused, as `command` or `command.arg`. */
  violations: string[];
  calls: { command: string; args: Record<string, unknown> }[];
  /** Commands the test answers; cloud commands without a handler are refused too. */
  handlers: Record<string, Handler>;
  /** Off while a test deliberately renders a local session. */
  strict: boolean;
  /** What a non-strict (local) call answers. */
  local: Handler;
  reset(): void;
}

export function guardedApi(): GuardedApi {
  const api: GuardedApi = {
    violations: [],
    calls: [],
    handlers: {},
    strict: true,
    local: () => null,
    invoke: async (command, args = {}) => {
      api.calls.push({ command, args });
      if (!api.strict) return (api.handlers[command] ?? api.local)(args);
      for (const key of LOCAL_PATH_ARGS) {
        if (typeof args[key] === "string") {
          api.violations.push(`${command}.${key}`);
          throw new LocalApiCalledError(`local path API ${command} called with ${key}=${String(args[key])} during a cloud test`);
        }
      }
      const handler = api.handlers[command];
      if (!handler) {
        api.violations.push(command);
        throw new LocalApiCalledError(`${command} is not a cloud API this test allows`);
      }
      return handler(args);
    },
    reset() {
      api.violations = [];
      api.calls = [];
      api.handlers = {};
      api.strict = true;
      api.local = () => null;
    },
  };
  return api;
}
