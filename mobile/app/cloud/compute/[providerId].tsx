import { useLocalSearchParams } from "expo-router";
import { ProviderScreen } from "@mobile/cloud/setup/compute/ProviderPage";
import { EmptyState } from "@mobile/ui/primitives";

/**
 * One compute provider of an organization (board 25.03): connect it, see its
 * stored key, replace it (`replace=1`) or disconnect it. Takes `orgId`.
 */
export default function ComputeProviderScreen() {
  const { orgId, providerId, replace } = useLocalSearchParams<{ orgId?: string; providerId: string; replace?: string }>();
  if (!orgId || !providerId) return <EmptyState title="Compute unavailable" detail="Open this from an organization." />;
  return <ProviderScreen orgId={orgId} providerId={providerId} replacing={replace === "1"} />;
}
