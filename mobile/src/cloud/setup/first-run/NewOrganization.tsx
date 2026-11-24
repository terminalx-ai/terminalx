import { useRef, useState } from "react";
import { ActivityIndicator } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { CloudApiError, organizationNameValid } from "../../api";
import { useCatalogSnapshot, useCloudCatalog } from "../../CloudProvider";
import { refusalText } from "../../words";
import { Notice } from "../../../ui/Notice";
import { Button, EmptyState } from "../../../ui/primitives";
import { TextField } from "../../../ui/TextField";
import { Note, Page } from "../logins/parts";
import { useSetupReads } from "./reads";
import * as W from "./words";

/** What went wrong with the last request: the name (under the field) or the request (a notice under it). */
type Failure = { where: "field" | "notice"; text: string } | null;

/** How a refused or failed creation is said (25.02). Never a code. */
export function creationFailure(error: unknown): Failure {
  if (!(error instanceof CloudApiError)) return { where: "notice", text: W.NOT_CREATED };
  if (error.code === "organization_name_invalid") return { where: "field", text: W.NAME_ERROR };
  if (error.refusal === "unreachable") return { where: "notice", text: W.NOT_CREATED };
  return { where: "notice", text: refusalText(error) };
}

/**
 * Creating an organization (25.02): one field, checked on the phone before
 * anything is sent (2 to 60 characters; the server checks again). While it
 * is sent the field is locked and the button says so; leaving does not undo
 * a request already sent. After a failure the name stays, and trying again
 * sends the same idempotency key, so a request that did arrive never makes
 * a second organization; a different name is a different request with a key
 * of its own. Created, the phone goes back to the Cloud tab with it as the
 * organization being set up.
 */
export function NewOrganization() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const router = useRouter();
  const catalog = useCloudCatalog();
  const snapshot = useCatalogSnapshot(catalog);
  const setup = useSetupReads(catalog, []);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  // One key per name: the same name tried again is the same request.
  const sent = useRef<{ name: string; key: string } | null>(null);

  const title = <Stack.Screen options={{ title: W.NEW_ORGANIZATION_TITLE, headerLargeTitle: false }} />;
  if (!catalog) return <>{title}<EmptyState title="Organization unavailable" detail="Sign in to create an organization." /></>;

  // A server without the phone's create route: say where one is made (25.02, "A server without the route").
  if (snapshot.createsOrganizations !== true) return <>{title}<Page testID="new-organization"><Note>{snapshot.organizations.length ? W.CREATE_ELSEWHERE : W.CREATE_ELSEWHERE_FIRST}</Note></Page></>;

  const valid = organizationNameValid(name);
  // The phone's own check comes first; the server's refusal of a name is said the same way.
  const nameError = name.trim().length > 0 && !valid ? W.NAME_ERROR : failure?.where === "field" ? failure.text : null;

  const create = async () => {
    if (!valid || busy) return;
    const trimmed = name.trim();
    if (sent.current?.name !== trimmed) sent.current = { name: trimmed, key: Crypto.randomUUID() };
    setBusy(true);
    setFailure(null);
    try {
      const organization = await catalog.createOrganization(trimmed, sent.current.key);
      setup.choose(organization.orgId);
      // Back to the Cloud tab: past the organization page when it opened this one.
      if (from === "organization") router.dismiss(2);
      else router.back();
    } catch (error) {
      setFailure(creationFailure(error));
      setBusy(false);
    }
  };

  return <>
    {title}
    <Page testID="new-organization" footer={<Button label={busy ? W.CREATING : W.CREATE} disabled={!valid || busy} onPress={() => void create()} icon={busy ? (color) => <ActivityIndicator size="small" color={color} /> : undefined} />}>
      <TextField label={W.NAME_LABEL} placeholder={W.NAME_LABEL} value={name} onChangeText={(value) => { setName(value); if (failure?.where === "field") setFailure(null); }}
        helper={W.NAME_HELPER} error={nameError} disabled={busy} autoFocus autoCapitalize="words" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => void create()} testID="organization-name" />
      {failure?.where === "notice" ? <Notice tone="danger" text={failure.text} testID="organization-not-created" /> : null}
    </Page>
  </>;
}
