import type { CloudOperation } from "../../api";
import { CLEANUP_KINDS, cleanupState, DELETE } from "./sentences";

/** Why a delete did not go through, in the console's sentence, with the provider's name. */
export function deletionRefusal(operation: Pick<CloudOperation, "errorCode" | "providerErrorCode">, provider: string): string {
  if (operation.errorCode === "cloud_provider_permission_denied") return DELETE.refused(provider, operation.providerErrorCode);
  return DELETE.unconfirmed(provider);
}

/** The cleanup report in plain words: what was removed, and what may still cost money. */
export function cleanupFacts(operation: Pick<CloudOperation, "cleanup">): { label: string; value: string; tone: "success" | "warning" | "danger" }[] {
  return (operation.cleanup?.items ?? []).filter((item) => CLEANUP_KINDS[item.kind]).map((item) => ({ label: CLEANUP_KINDS[item.kind]!, ...cleanupState(item.kind, item.state) }));
}
