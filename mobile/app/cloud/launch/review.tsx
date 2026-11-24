import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { refusalText } from "@mobile/cloud/words";
import { useHeldLaunch, useLaunchSnapshot } from "@mobile/cloud/setup/launch/flow";
import { LaunchHeader, LaunchPage } from "@mobile/cloud/setup/launch/parts";
import { reviewFacts } from "@mobile/cloud/setup/launch/review";
import { billingNote, priceChangedText, SPEND_TITLE, spendSentence } from "@mobile/cloud/setup/launch/words";
import { FactRows } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { PriceLines } from "@mobile/ui/PriceLines";
import { Button, SectionTitle } from "@mobile/ui/primitives";

/**
 * The review and the spend confirmation (25.05 row 4): the configuration,
 * the quote's price and how long it holds, then Launch workspace, which only
 * asks. Only the confirmation's Launch sends the request, with the spend
 * confirmation the server requires; on the server's yes the new workspace's
 * page opens.
 */
export default function LaunchReviewScreen() {
  const { orgId = "" } = useLocalSearchParams<{ orgId?: string }>();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const organizationName = useCatalogSnapshot(catalog).organizations.find((entry) => entry.organization.orgId === orgId)?.organization.name ?? "";
  const flow = useHeldLaunch(orgId);
  const { review } = useLaunchSnapshot(flow);
  const header = <>
    <Stack.Screen options={{ title: "Review", headerLargeTitle: false, headerShown: false }} />
    <LaunchHeader title="Review" subtitle={organizationName} onBack={() => router.back()} />
  </>;
  // Opened without a form behind it: there is nothing priced to review.
  if (!flow || !review) return header;

  const descriptor = review.facts.provider.descriptor;
  const launch = async () => {
    const launched = await flow.launch();
    if (!launched) return;
    void catalog?.refresh();
    router.dismissAll();
    router.push(`/cloud/${encodeURIComponent(launched.workspace.id)}?orgId=${encodeURIComponent(orgId)}`);
  };
  const confirm = () => Alert.alert(SPEND_TITLE, spendSentence(descriptor, review.facts.organizationName || organizationName, review.quote), [
    { text: "Cancel", style: "cancel" },
    { text: "Launch", onPress: () => void launch() },
  ]);

  const foot = review.expired
    ? <Button testID="launch-new-price" label="Get a new price" disabled={review.requoting} accessibilityState={{ disabled: review.requoting, busy: review.requoting }}
      icon={review.requoting ? (color) => <ActivityIndicator size="small" color={color} /> : undefined} onPress={() => void flow.requote()} />
    : <Button testID="launch-workspace" label={review.launching ? "Launching…" : "Launch workspace"} disabled={review.launching} accessibilityState={{ disabled: review.launching, busy: review.launching }}
      icon={review.launching ? (color) => <ActivityIndicator size="small" color={color} /> : undefined} onPress={confirm} />;

  return <>
    {header}
    <LaunchPage foot={foot}>
      <FactRows testID="launch-review-facts" facts={reviewFacts(review)} />
      <View style={styles.section}><SectionTitle>Price</SectionTitle></View>
      <PriceLines testID="price" quote={review.quote} now={flow.serverNow} note={billingNote(descriptor, review.quote.currency)} onExpired={() => flow.expire()} />
      {review.expired ? <Notice testID="launch-expired" tone="warning" text={refusalText("quote-expired")} />
        : review.previous ? <Notice testID="launch-price-changed" tone="warning" text={priceChangedText(review.previous)} /> : null}
      {review.error ? <Notice testID="launch-error" tone="danger" text={refusalText(review.error)} /> : null}
    </LaunchPage>
  </>;
}

const styles = StyleSheet.create({
  section: { marginTop: 12 },
});
