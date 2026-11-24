import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCatalogSnapshot, useCloudCatalog } from "@mobile/cloud/CloudProvider";
import { CloudApiError } from "@mobile/cloud/api";
import { refusalText } from "@mobile/cloud/words";
import { useRead } from "@mobile/cloud/setup/read";
import { useHeldLaunch, useLaunchSnapshot } from "@mobile/cloud/setup/launch/flow";
import { readLogins } from "@mobile/cloud/setup/launch/form";
import { parseRepository } from "@mobile/cloud/setup/launch/repository";
import { LaunchPage, LinkRow } from "@mobile/cloud/setup/launch/parts";
import { REPOSITORY_HELPER, REPOSITORY_INTRO } from "@mobile/cloud/setup/launch/words";
import { Button, Card } from "@mobile/ui/primitives";
import { ScreenHeader } from "@mobile/ui/SessionChrome";
import { TextField } from "@mobile/ui/TextField";
import { useTheme } from "@mobile/ui/theme";

const REF_NOT_FOUND = "cloud_workspace_repository_ref_not_found";

/**
 * The repository a new workspace clones (25.05): one GitHub URL, typed or
 * pasted, and an optional branch or tag. A check that failed on it is said
 * under the field it is about; one that needs a GitHub token offers Agent
 * logins, and the form can go on without a repository.
 */
export default function LaunchRepositoryScreen() {
  const { orgId = "" } = useLocalSearchParams<{ orgId?: string }>();
  const router = useRouter();
  const { palette } = useTheme();
  const flow = useHeldLaunch(orgId);
  const { draft, check } = useLaunchSnapshot(flow);
  const organizationName = useCatalogSnapshot(useCloudCatalog()).organizations.find((entry) => entry.organization.orgId === orgId)?.organization.name ?? "";
  const [url, setUrl] = useState(draft.repository?.url ?? "");
  const [ref, setRef] = useState(draft.repository?.ref ?? "");

  // Back from Agent logins with a token saved: what failed for want of one is cleared.
  const logins = useRead((client) => readLogins(client, orgId), [orgId], { refreshOnFocus: true });
  useEffect(() => { if (flow && logins.value) flow.loginsRead(logins.value); }, [flow, logins.value]);

  // What the last check said about this repository, while it is still the one checked.
  const unchanged = draft.repository !== null && draft.repository.url === url && draft.repository.ref === ref;
  const failed = unchanged && check.state === "problems" ? check.problems.find((problem) => problem.field?.kind === "repository") ?? null : null;
  const refused = failed?.code ? new CloudApiError(failed.code, 422) : null;
  const refMissing = refused?.code === REF_NOT_FOUND;
  const needsToken = refused?.refusal === "repository-login-required";
  const urlError = refused && !refMissing ? refusalText(refused) : null;
  const usable = parseRepository(url) !== null;

  const use = () => {
    flow?.edit({ repository: { url: url.trim(), ref: ref.trim() } });
    router.back();
  };
  const without = () => {
    flow?.edit({ repository: null });
    router.back();
  };

  return <>
    <Stack.Screen options={{ title: "Repository", headerLargeTitle: false, headerShown: false }} />
    <ScreenHeader title="Repository" onBack={() => router.back()} />
    <LaunchPage foot={<>
      <Button testID="launch-use-repository" label="Use this repository" disabled={!flow || !usable} accessibilityState={{ disabled: !flow || !usable }} onPress={use} />
      {draft.repository ? <Button testID="launch-without-repository" label="Launch without a repository" kind="secondary" onPress={without} /> : null}
    </>}>
      <Text style={[styles.intro, { color: palette.muted }]}>{REPOSITORY_INTRO}</Text>
      <TextField label="GitHub repository URL" value={url} onChangeText={setUrl} placeholder="github.com/owner/repository" error={urlError} autoFocus={!draft.repository} paste
        autoCapitalize="none" autoCorrect={false} spellCheck={false} keyboardType="url" returnKeyType="next" testID="launch-repository-url" />
      <View style={styles.gap}>
        <TextField label="Branch or tag" hint="optional" value={ref} onChangeText={setRef} placeholder="main" error={refMissing ? refusalText(refused) : null}
          autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="done" testID="launch-repository-ref" />
      </View>
      {needsToken
        ? <Card style={styles.gap}><LinkRow testID="launch-add-github-token" title="Add a GitHub token" detail={`Saved for ${organizationName}, in Agent logins`} onPress={() => router.push(`/cloud/logins/github?orgId=${encodeURIComponent(orgId)}`)} /></Card>
        : <Text style={[styles.helper, { color: palette.muted }]}>{REPOSITORY_HELPER}</Text>}
    </LaunchPage>
  </>;
}

const styles = StyleSheet.create({
  intro: { fontSize: 15, lineHeight: 21, marginHorizontal: 4, marginBottom: 6 },
  gap: { marginTop: 6 },
  helper: { fontSize: 13, lineHeight: 18, marginHorizontal: 4, marginTop: -2 },
});
