let guard: ((leave: () => void) => void) | null = null;
let leaving = false;

/** The environment owns the prompt; navigation keeps its exact destination until answered. */
export function registerEnvironmentLeaveGuard(prompt: (leave: () => void) => void): () => void {
  guard = prompt;
  return () => { if (guard === prompt) guard = null; };
}

export function allowEnvironmentLeave(action: () => void): boolean {
  if (!guard || leaving) return true;
  guard(() => {
    leaving = true;
    try { action(); } finally { leaving = false; }
  });
  return false;
}

export function navigateFromEnvironment(action: () => void): void {
  if (allowEnvironmentLeave(action)) action();
}
