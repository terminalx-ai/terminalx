import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import type { LocalVmGuestAccount, LocalVmGuestAccountStatus, LocalVmGuestKeyStage, LocalVmPersonApproval } from "@/types/localVm";
import type { SessionEntry, TabEntry } from "@/types/session";

const accountId = (account: LocalVmGuestAccount) => `${account.uid}:${account.name}`;

const keyStages: Record<LocalVmGuestKeyStage, string> = {
  notGranted: "TerminalX's SSH key is not installed in this account yet. Installing it creates this VM's one key; it does not trust the VM or make SSH ready.",
  keyPending: "TerminalX started creating this VM's SSH key and has not granted it yet. Retrying uses only that original key; a second key is never created.",
  grantPending: "A key grant is recorded. Waiting for the guest helper's install result.",
  publicKeyInstalled: "The guest helper installed TerminalX's public key in this account. SSH is not trusted or ready yet.",
  outcomeUnknown: "The key install outcome is unknown. It is not retried or treated as installed; inspect the VM.",
  refused: "The guest helper refused the key install. Nothing was written to the account.",
};

/** This conversation's guest-account choices. Key proof alone never chooses an
 *  account: the person picks one from the exact list the guest reported, and
 *  only the helper's acknowledgement authenticates it. Never trust or readiness. */
export function GuestAccountConfirmations({ session, tab, conversation, readOnly }: {
  session: SessionEntry; tab: TabEntry; conversation: string | null; readOnly: boolean;
}) {
  const [items, setItems] = useState<LocalVmGuestAccountStatus[] | null>(null);
  const [approval, setApproval] = useState<LocalVmPersonApproval>({ available: false });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!conversation) return;
    try {
      const result = await localVmRequest("environment.guestAccountConfirmations", { parentSession: session.id, parentTab: tab.id, parentConversation: conversation });
      setItems(result.bootstraps); setApproval(result.personApproval ?? { available: false }); setError(null);
    } catch (error) { setError(errorMessage(error)); }
  }, [session.id, tab.id, conversation]);
  useEffect(() => { void load(); }, [load]);
  if (!conversation || (!items?.length && !error)) return null;
  // Person-only steps are refused by the backend unless this build can verify
  // the person's approval; the guest's reports stay visible either way.
  const locked = readOnly || !approval.available;
  return <section aria-label="Guest account confirmation" className="space-y-2 py-2">
    {!approval.available ? <p role="status" className="text-muted-foreground">{approval.reason ?? "TerminalX cannot yet verify that a person approved these steps."} The guest's reports are shown; choosing an account, installing the key and pinning the host key stay unavailable.</p> : null}
    {items?.map((item) => <Confirmation key={item.idempotencyKey} item={item} session={session} tab={tab} conversation={conversation} readOnly={locked} reload={load} />)}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </section>;
}

function Confirmation({ item, session, tab, conversation, readOnly, reload }: {
  item: LocalVmGuestAccountStatus; session: SessionEntry; tab: TabEntry; conversation: string; readOnly: boolean; reload: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  // A changed list is a different observation: any earlier selection is dropped.
  useEffect(() => { setSelected(null); setConsent(false); }, [item.observationSha256]);

  async function check() {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await reload(); } finally { lock.current = false; setBusy(false); }
  }

  async function grantKey() {
    if (lock.current || readOnly) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await localVmRequest("environment.grantGuestKey", { idempotencyKey: item.idempotencyKey, confirm: true,
        parentSession: session.id, parentTab: tab.id, parentConversation: conversation });
    } catch (error) {
      setError(`${errorMessage(error)} Retrying uses only this VM's original key; it is never replaced.`);
    } finally { await reload(); lock.current = false; setBusy(false); }
  }

  async function confirm() {
    const account = item.accounts.find((candidate) => accountId(candidate) === selected);
    if (lock.current || readOnly || !consent || !account || !item.observationSha256) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await localVmRequest("environment.confirmGuestAccount", { idempotencyKey: item.idempotencyKey, confirm: true,
        observationSha256: item.observationSha256, account, parentSession: session.id, parentTab: tab.id, parentConversation: conversation });
    } catch (error) {
      setError(`${errorMessage(error)} If the guest's account list changed, review the current list. Retrying the same choice is safe; a different account is never accepted after one was chosen.`);
    } finally { await reload(); lock.current = false; setBusy(false); }
  }

  const checkButton = <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void check()}>Check again</Button>;
  let body;
  if (item.answer) {
    const { account, outcome } = item.answer;
    body = <>
      <p role="status">{outcome === "confirmed"
        ? `The guest helper confirmed ${account.name} (UID ${account.uid}). This account is authenticated for this VM only; it is not trust or SSH readiness.`
        : `The guest helper refused ${account.name}: it no longer matches the guest. The choice is not changed or retried; inspect the VM.`}</p>
      {outcome === "confirmed" && item.key ? <p role="status">{keyStages[item.key.stage]}</p> : null}
      {outcome === "confirmed" && item.key && ["notGranted", "keyPending", "grantPending"].includes(item.key.stage) ? <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || readOnly} onClick={() => void grantKey()}>{busy ? "Working…" : item.key.stage === "notGranted" ? "Install SSH key" : "Retry with the original key"}</Button>
        {checkButton}
      </div> : null}
      {outcome === "confirmed" && !item.key ? checkButton : null}
      {outcome === "confirmed" && item.hostKey ? <HostKeyReview item={item} session={session} tab={tab} conversation={conversation} readOnly={readOnly} reload={reload} checkButton={checkButton} /> : null}
    </>;
  } else if (item.chosen) {
    body = <>
      <p role="status">You chose {item.chosen.name} (UID {item.chosen.uid}). Waiting for the guest helper to acknowledge it. This choice cannot be changed.</p>
      {checkButton}
    </>;
  } else if (!item.observationSha256) {
    body = <>
      <p role="status">Waiting for the guest helper to report its accounts. The helper may still be starting, or the VM owner is unreachable.{item.detail ? ` ${item.detail}` : ""}</p>
      {checkButton}
    </>;
  } else {
    body = <>
      <p>The guest helper proved it runs in this VM and reported these accounts. That proof does not choose an account: pick the one TerminalX may use.</p>
      <fieldset className="space-y-1" disabled={busy || readOnly}>
        <legend className="sr-only">Guest accounts</legend>
        {item.accounts.map((account) => <label key={accountId(account)} className="flex items-center gap-2">
          <input type="radio" name={`guest-account-${item.idempotencyKey}`} checked={selected === accountId(account)} onChange={() => { setSelected(accountId(account)); setConsent(false); }} />
          <span>{account.name} · UID {account.uid} · {account.home}</span>
        </label>)}
      </fieldset>
      <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={consent} disabled={busy || readOnly || !selected} onChange={(event) => setConsent(event.target.checked)} /><span>I confirm TerminalX may use this account in this VM. This choice is permanent for this VM and does not make SSH trusted or ready.</span></label>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || readOnly || !selected || !consent} onClick={() => void confirm()}>{busy ? "Confirming…" : "Confirm account"}</Button>
        {checkButton}
      </div>
    </>;
  }
  return <div className="space-y-2 rounded-md border border-border p-3">
    <p className="font-medium">Choose the guest account for this VM</p>
    {body}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}

/** The person's review of the guest's SSH host key, as the authenticated helper
 *  reported it. Pinning needs the exact fingerprint shown and explicit consent;
 *  a different key is refused, and pinning is not a verified SSH connection. */
function HostKeyReview({ item, session, tab, conversation, readOnly, reload, checkButton }: {
  item: LocalVmGuestAccountStatus; session: SessionEntry; tab: TabEntry; conversation: string; readOnly: boolean; reload: () => Promise<void>; checkButton: ReactNode;
}) {
  const hostKey = item.hostKey;
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  useEffect(() => { setConsent(false); }, [hostKey?.observationSha256]);
  if (!hostKey) return null;

  async function pin() {
    if (lock.current || readOnly || !consent || !hostKey?.observationSha256 || !hostKey.fingerprint) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await localVmRequest("environment.confirmGuestHostKey", { idempotencyKey: item.idempotencyKey, confirm: true,
        observationSha256: hostKey.observationSha256, fingerprint: hostKey.fingerprint,
        parentSession: session.id, parentTab: tab.id, parentConversation: conversation });
    } catch (error) {
      setError(`${errorMessage(error)} A pinned host key is never replaced.`);
    } finally { await reload(); lock.current = false; setBusy(false); }
  }

  const fingerprint = <code className="break-all font-mono">{hostKey.fingerprint}</code>;
  return <div className="space-y-2 border-t border-border pt-2">
    <p className="font-medium">SSH host key</p>
    {hostKey.stage === "awaitingHostKey" ? <>
      <p role="status">Waiting for this VM's SSH host key. If Remote Login is off in the VM, turn it on for this account in System Settings. TerminalX never turns it on or creates host keys.</p>
      {checkButton}
    </> : null}
    {hostKey.stage === "awaitingReview" ? <>
      <p>The helper in this VM reported this SSH host key fingerprint: {fingerprint}</p>
      <p className="text-muted-foreground">To check it yourself, run <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> in the VM&apos;s Terminal and compare.</p>
      <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={consent} disabled={busy || readOnly} onChange={(event) => setConsent(event.target.checked)} /><span>I reviewed this fingerprint and allow TerminalX to pin it for SSH to this VM. A different key will be refused.</span></label>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || readOnly || !consent} onClick={() => void pin()}>{busy ? "Pinning…" : "Pin host key"}</Button>
        {checkButton}
      </div>
    </> : null}
    {hostKey.stage === "confirmed" ? <p role="status">Host key pinned: {fingerprint}. TerminalX has not connected over SSH yet; the first connection checks this exact key and stops on any mismatch.</p> : null}
    {hostKey.stage === "changed" ? <p role="alert" className="text-destructive">This VM now reports a different SSH host key than the pinned one ({fingerprint}). TerminalX refuses to connect and never replaces the pinned key. Inspect the VM.</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}
