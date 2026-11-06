import { navigateFromEnvironment } from "@/lib/environmentLeaveGuard";
const EVENT = "terminalx:cloud-setup";
export function openCloudSetup(organizationId: string | null = null): void {
  navigateFromEnvironment(() => window.dispatchEvent(new CustomEvent(EVENT, { detail: organizationId })));
}
export function onOpenCloudSetup(listener: (organizationId: string | null) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<string | null>).detail);
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
