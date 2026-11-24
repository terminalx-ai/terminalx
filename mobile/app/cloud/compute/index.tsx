import { useLocalSearchParams } from "expo-router";
import { ComputeList } from "@mobile/cloud/setup/compute/ComputeList";
import { EmptyState } from "@mobile/ui/primitives";

/** Step 2 of cloud setup (board 25.03): an organization's compute providers. Takes `orgId`. */
export default function ComputeScreen() {
  const { orgId } = useLocalSearchParams<{ orgId?: string }>();
  if (!orgId) return <EmptyState title="Compute unavailable" detail="Open this from an organization." />;
  return <ComputeList orgId={orgId} />;
}
