import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import type { CloudCredential } from "@mobile/cloud/api";
import { changeRefusal, dayText, FINGERPRINT_HELP, isSubscription, loginKind, refusalOf, removeQuestion, revokeQuestion, signInRequiredNote, STILL_IN_USE, type LoginAgent } from "@mobile/cloud/logins";
import { FactRows, type Fact } from "@mobile/ui/FactRows";
import { Notice } from "@mobile/ui/Notice";
import { Button, Card } from "@mobile/ui/primitives";
import { ProviderRow } from "@mobile/ui/ProviderRow";
import { credentialBadge } from "@mobile/ui/StateBadge";
import { Help, LoginPage } from "./LoginPage";

/**
 * A stored login (25.04): what it is, whose, and its fingerprint, never the
 * login itself. Replace opens the way in again; Revoke keeps the row and
 * stops the login being handed out; Remove deletes it. Both ask first.
 */
export function SavedLogin({ agent, credential, organization, revoke, remove, onReplace, onRevoked, onRemoved }: {
  agent: LoginAgent;
  credential: CloudCredential;
  organization: string;
  revoke(): Promise<CloudCredential>;
  remove(): Promise<void>;
  onReplace(): void;
  onRevoked(credential: CloudCredential): void;
  onRemoved(): void;
}) {
  const [busy, setBusy] = useState<"revoke" | "remove" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const run = (what: "revoke" | "remove") => {
    setBusy(what);
    setProblem(null);
    const done = what === "revoke" ? revoke().then(onRevoked) : remove().then(onRemoved);
    done.catch((error: unknown) => {
      if (!live.current) return;
      if (what === "remove" && refusalOf(error) === "login-in-use") Alert.alert(STILL_IN_USE.title, STILL_IN_USE.body, [{ text: "OK" }]);
      else setProblem(changeRefusal(error));
    }).finally(() => { if (live.current) setBusy(null); });
  };
  const ask = (what: "revoke" | "remove") => {
    const question = what === "revoke" ? revokeQuestion(agent) : removeQuestion(agent, credential);
    Alert.alert(question.title, question.body, [
      { text: "Cancel", style: "cancel" },
      { text: what === "revoke" ? "Revoke" : "Remove", style: "destructive", onPress: () => run(what) },
    ]);
  };

  const revoked = credential.state === "revoked";
  const signIn = credential.state === "sign-in-required";
  const facts: Fact[] = [
    ...(credential.displayIdentity ? [{ label: "Account", value: credential.displayIdentity }] : []),
    { label: "Key", value: credential.fingerprint, mono: true },
    { label: "Updated", value: dayText(credential.updatedAt, true) },
  ];
  const again = signIn && isSubscription(credential);
  return <LoginPage testID="saved-login" footer={<>
    <Button label={again ? "Sign in again" : "Replace"} kind={again ? "primary" : "secondary"} disabled={busy !== null} onPress={onReplace} />
    {revoked
      ? <Button label="Remove…" kind="danger" disabled={busy !== null} accessibilityState={{ disabled: busy !== null, busy: busy === "remove" }} onPress={() => ask("remove")} />
      : <Button label="Revoke…" kind="danger" disabled={busy !== null} accessibilityState={{ disabled: busy !== null, busy: busy === "revoke" }} onPress={() => ask("revoke")} />}
  </>}>
    <Card>
      <ProviderRow name={agent.name} description={loginKind(credential.authKind)} letter={agent.name} badge={credentialBadge(credential.state)} badgeAtEnd />
      <FactRows embedded facts={facts} testID="saved-login-facts" />
    </Card>
    {signIn ? <Notice tone="warning" text={signInRequiredNote(agent, credential, organization)} testID="saved-login-notice" /> : <Help>{FINGERPRINT_HELP}</Help>}
    {problem ? <Notice tone="danger" text={problem} testID="saved-login-problem" /> : null}
  </LoginPage>;
}
