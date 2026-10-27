const ATTEMPTS = "terminalx.localRuntime.attempts.v1";
export const RECOVERY_DELAYS = [1_000, 2_000, 4_000];

/** This budget belongs to the window browsing lifetime, not a React effect or
 * document. Reader release and a healthy control reply do not establish fresh
 * output from a replacement reader. Conservatively never replenish automatically;
 * manual recovery remains available after the three automatic attempts. */
export function recoveryAttempts(): number {
  try {
    const value = Number(sessionStorage.getItem(ATTEMPTS) ?? 0);
    return Number.isInteger(value) && value >= 0 ? Math.min(value, RECOVERY_DELAYS.length) : RECOVERY_DELAYS.length;
  } catch { return RECOVERY_DELAYS.length; }
}

export function recordRecoveryAttempt(): number {
  const next = Math.min(recoveryAttempts() + 1, RECOVERY_DELAYS.length);
  // Persist before issuing native recovery, including when the reply arrives
  // after unmount. If this fails, no automatic reload/reconnect is issued.
  sessionStorage.setItem(ATTEMPTS, String(next));
  return next;
}
