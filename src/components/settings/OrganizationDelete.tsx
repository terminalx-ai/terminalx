import { useEffect, useRef, useState } from "react";
import { organizationDeletionError, organizationDeletionText as text, organizationNameConfirmed } from "@terminalx/portable/organizationDeletion";
import { Check, Copy, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, type OrganizationSummary } from "@/lib/api";
import { copyText } from "@/lib/clipboard";

export interface OrganizationDeleteConfirmation {
  organizationId: string;
  contextRevision: string;
  confirmationName: string;
}

/** Account authentication and server authority stay in the native deletion bridge. */
export function OrganizationDelete({ organization, contextRevision, unavailableReason, remove, onDeleted }: {
  organization: OrganizationSummary;
  contextRevision: string;
  unavailableReason?: string;
  remove: (confirmation: OrganizationDeleteConfirmation) => Promise<void>;
  onDeleted: () => void;
}) {
  const [confirmation, setConfirmation] = useState<OrganizationDeleteConfirmation | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const flight = useRef(false);
  const epoch = useRef(0);
  // Read on submit as well as render: an old confirmation never authorizes a new context.
  const current = useRef({ organization, contextRevision, unavailableReason });
  current.current = { organization, contextRevision, unavailableReason };
  useEffect(() => {
    epoch.current += 1;
    setConfirmation(null);
    setTyped("");
    setError(null);
    setCopied(false);
    setBusy(false);
    flight.current = false;
    return () => { epoch.current += 1; };
  }, [organization.id, organization.name, organization.role, contextRevision, unavailableReason]);

  if (organization.role !== "owner") return null;

  const submit = async () => {
    const latest = current.current;
    if (flight.current || !confirmation || !organizationNameConfirmed(typed, confirmation.confirmationName) ||
        latest.unavailableReason || latest.organization.role !== "owner" ||
        latest.organization.id !== confirmation.organizationId || latest.organization.name !== confirmation.confirmationName ||
        latest.contextRevision !== confirmation.contextRevision) return;
    const attempt = epoch.current;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      await remove(confirmation);
      if (epoch.current === attempt) { setConfirmation(null); setTyped(""); onDeleted(); }
    } catch (failure) {
      if (epoch.current === attempt) {
        setError(organizationDeletionError(failure));
      }
    } finally {
      if (epoch.current === attempt) {
        // A refusal retains the exact confirmation, but never automatically retries.
        setBusy(false);
        flight.current = false;
      }
    }
  };

  const confirmed = !!confirmation && organizationNameConfirmed(typed, confirmation.confirmationName);
  const copyName = (name: string) => {
    const attempt = epoch.current;
    copyText(name).then(() => { if (epoch.current === attempt) setCopied(true); },
      () => { if (epoch.current === attempt) setError("Could not copy the name. Select it and copy it, or type it."); });
  };

  return (
    <section className="rounded-lg border border-destructive/30 p-3" aria-label={text.title}>
      <h4 className="text-sm font-medium">{text.title}</h4>
      <p className="mt-1 text-xs text-muted-foreground">{text.warning(organization.name)}</p>
      {unavailableReason ? <p className="mt-2 text-xs text-muted-foreground">{unavailableReason}</p> : (
        confirmation ? (
          <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <p className="text-xs">{text.prompt}</p>
            <div className="flex items-center gap-2">
              {/* The body is not selectable (app.css); the name is, so it can be copied by hand too. */}
              <span data-testid="organization-delete-name" className="select-text min-w-0 cursor-text break-all rounded bg-well px-1.5 py-0.5 text-xs font-medium">{confirmation.confirmationName}</span>
              <Button type="button" size="sm" variant="outline" aria-label={text.copy} title={text.copy} disabled={busy}
                onClick={() => copyName(confirmation.confirmationName)}>
                {copied ? <Check /> : <Copy />} {copied ? text.copied : text.copy}
              </Button>
            </div>
            <input aria-label={text.inputLabel} autoComplete="off" spellCheck={false} disabled={busy}
              value={typed} onChange={(event) => setTyped(event.target.value)}
              className="block h-8 w-full rounded-md border border-hairline bg-well px-2 text-sm" />
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" size="sm" disabled={busy || !confirmed}>
                {busy && <Loader2 className="animate-spin" />} {text.confirm(confirmation.confirmationName)}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setTyped(""); setCopied(false); }}>{text.cancel}</Button>
            </div>
          </form>
        ) : <Button className="mt-3" variant="destructive" size="sm" disabled={!contextRevision || !organization.name}
          onClick={() => { setError(null); setTyped(""); setCopied(false); setConfirmation({ organizationId: organization.id, contextRevision, confirmationName: organization.name }); }}>
          {text.start}
        </Button>
      )}
      {error && <>
        <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>
        <Button type="button" className="mt-2" size="sm" variant="outline" disabled={busy}
          onClick={() => {
            const attempt = epoch.current;
            void api.organizationConsoleOpen(organization.id).catch(() => {
              if (epoch.current === attempt) setError("Could not open the organization's console. Use this organization's existing settings to finish cleanup.");
            });
          }}>
          Open {organization.name} cleanup settings
        </Button>
      </>}
    </section>
  );
}
