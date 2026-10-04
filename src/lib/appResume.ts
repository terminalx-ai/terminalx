/**
 * Webviews do not consistently report screen unlock or sleep as visibility
 * changes. Focus/pageshow cover returning to the app; a delayed heartbeat
 * covers a suspended webview that stayed visible. These are recovery hints,
 * never evidence that a process stopped (or that the machine slept).
 */
export function onAppResume(recover: () => void): () => void {
  let lastTick = Date.now();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    if (document.hidden || pending !== undefined) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (!document.hidden) recover();
    }, 100);
  };
  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 15_000) request();
    lastTick = now;
  }, 5_000);
  document.addEventListener("visibilitychange", request);
  window.addEventListener("focus", request);
  window.addEventListener("pageshow", request);
  return () => {
    clearInterval(heartbeat);
    clearTimeout(pending);
    document.removeEventListener("visibilitychange", request);
    window.removeEventListener("focus", request);
    window.removeEventListener("pageshow", request);
  };
}
