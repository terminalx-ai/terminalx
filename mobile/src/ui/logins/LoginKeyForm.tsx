import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CloudCredential, CloudCredentialAuthKind, CredentialConsent } from "@mobile/cloud/api";
import { checkingText, KEY_HELP, LOGIN_CONSENT, loginPurpose, saveRefusal, type LoginAgent } from "@mobile/cloud/logins";
import { ConsentRow } from "@mobile/ui/ConsentRow";
import { Notice } from "@mobile/ui/Notice";
import { Button } from "@mobile/ui/primitives";
import { TextField, type TextFieldHandle } from "@mobile/ui/TextField";
import { Lead, LoginPage } from "./LoginPage";

export interface KeyToSave {
  authKind: CloudCredentialAuthKind;
  secret: string;
  displayIdentity: string | null;
}

/**
 * The form a key or token is pasted into (25.04): one for Codex's, Claude
 * Code's and Cursor's API key and GitHub's token; only the label differs.
 *
 * The secret is read from its field once, for the one request that sends it,
 * and the field is emptied in the same breath: whatever the service answers,
 * the phone holds no copy and never draws it. A key the check refused, or one
 * the check could not run for, is pasted again.
 */
export function LoginKeyForm({ agent, organization, save, onSaved, above, consent, onConsentChange }: {
  agent: LoginAgent;
  /** The organization's name, for the sentence that says whose workspaces use the login. */
  organization: string;
  save(key: KeyToSave, consent: CredentialConsent): Promise<CloudCredential>;
  onSaved(credential: CloudCredential): void;
  /** Drawn over the form: Codex's choice between its two ways in. */
  above?: ReactNode;
  consent: boolean;
  onConsentChange(value: boolean): void;
}) {
  const field = useRef<TextFieldHandle>(null);
  const [filled, setFilled] = useState(false);
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ where: "field" | "form"; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const send = () => {
    const secret = field.current?.read() ?? "";
    if (!secret || !consent || busy) return;
    setBusy(true);
    setProblem(null);
    // The switch is the person's yes to both things the service asks: shared with the organization, installed on its machines.
    const sent = save({ authKind: agent.keyKind, secret, displayIdentity: who.trim() || null }, { organizationSharing: true, machineInstallation: true });
    // Sent: nothing of it stays in the field, whatever the answer.
    field.current?.clear();
    sent.then((credential) => {
      if (live.current) onSaved(credential);
    }, (error: unknown) => {
      if (!live.current) return;
      const refusal = saveRefusal(error, agent);
      setProblem(refusal);
      setBusy(false);
      if (refusal.where === "field") field.current?.focus();
    });
  };

  return <LoginPage testID="login-key-form" footer={<Button label={busy ? checkingText(agent) : "Save"} accessibilityState={{ disabled: !filled || !consent || busy, busy }} disabled={!filled || !consent || busy} onPress={send} />}>
    <Lead>{loginPurpose(agent, organization)}</Lead>
    {above}
    <TextField ref={field} secret label={agent.keyLabel} placeholder={agent.keyLabel} paste disabled={busy} mono
      helper={KEY_HELP} error={problem?.where === "field" ? problem.text : null}
      onFilledChange={(value) => { setFilled(value); if (value) setProblem(null); }} testID="login-key-field" />
    <TextField label="Whose account this is" hint="optional" placeholder="A name or email, shown to admins" value={who} onChangeText={setWho} disabled={busy}
      autoCapitalize="none" autoCorrect={false} maxLength={200} returnKeyType="done" testID="login-identity-field" />
    <ConsentRow text={LOGIN_CONSENT} value={consent} onValueChange={onConsentChange} disabled={busy} testID="login-consent" />
    {problem?.where === "form" ? <Notice tone="danger" text={problem.text} testID="login-key-problem" /> : null}
  </LoginPage>;
}
